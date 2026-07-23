"""分身农庄 - WebSocket 低延迟双向通道（P4）

架构（与 stardew-mcp 相反、更稳健的方向）：
- Python/brain 作为 WebSocket **服务端**（ws://localhost:8765）
- 游戏内 MOD 作为**客户端**主动连入（WsClient.cs，3 秒断线重连）

优势：
- 下行命令即时到达（绕过 actions/*.json 的 0.5s 文件轮询）
- 上行 state 每 0.5s 推送（与 bridge_data.json 同构），无需读盘
- brain 重启只是断开重连，游戏不用动；游戏重启 MOD 自动重连
- 文件桥全程保留：WS 断开时 HybridBridge 自动回退，行为与之前完全一致
"""
from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Dict, Optional

from loguru import logger

try:
    import websockets
    _WS_AVAILABLE = True
except ImportError:  # 库缺失时整体回退文件桥
    websockets = None
    _WS_AVAILABLE = False


class WsStateServer:
    """WebSocket 服务端：接收 MOD 推来的 state，向 MOD 下发 command。

    在后台守护线程里跑独立 asyncio 事件循环，主线程（Brain 循环）只通过
    线程安全的属性/方法交互。
    """

    def __init__(self, host: str = "localhost", port: int = 8765):
        self.host = host
        self.port = port
        self.clients: set = set()
        self.latest_state: Optional[Dict[str, Any]] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._started = False

    @property
    def connected(self) -> bool:
        return bool(self.clients)

    def start(self) -> bool:
        """启动后台服务端线程。返回是否可用（库缺失返回 False）。"""
        if not _WS_AVAILABLE:
            logger.warning("websockets 库缺失（pip install websockets）— 仅使用文件桥")
            return False
        if self._started:
            return True
        self._started = True
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="ws-state-server")
        self._thread.start()
        return True

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
        except Exception as e:
            logger.warning(f"WS 服务端异常退出: {e}")

    async def _serve(self) -> None:
        async with websockets.serve(self._handler, self.host, self.port):
            logger.info(f"WS 服务端已监听 ws://{self.host}:{self.port}，等待 MOD 连入")
            await asyncio.Future()  # run forever

    async def _handler(self, ws, path=None) -> None:
        # path 形参兼容 websockets 新旧两版 handler 签名
        self.clients.add(ws)
        logger.success(f"MOD 已连入 WebSocket（{getattr(ws, 'remote_address', '?')}）— 低延迟通道在线")
        try:
            async for msg in ws:
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                if isinstance(data, dict) and data.get("type") == "state":
                    self.latest_state = data.get("data")
        except Exception:
            pass
        finally:
            self.clients.discard(ws)
            logger.warning("MOD WebSocket 断开 — 自动回退文件桥")

    def send_command(self, action: Dict[str, Any]) -> bool:
        """向已连 MOD 即时下发动作 JSON（与 actions/*.json 同构）。无连接返回 False。"""
        if not self.clients or not self._loop:
            return False
        msg = json.dumps(action, ensure_ascii=False)
        asyncio.run_coroutine_threadsafe(self._broadcast(msg), self._loop)
        return True

    async def _broadcast(self, msg: str) -> None:
        for ws in list(self.clients):
            try:
                await ws.send(msg)
            except Exception:
                self.clients.discard(ws)


class HybridBridge:
    """文件桥 + WebSocket 的复合桥。

    - send：WS 在线走 WS（低延迟），否则写 actions/*.json 文件
    - read_state：WS 在线用最新推送缓存，否则读 bridge_data.json
    - 接口与 agent.ActionBridge 完全一致，对 Brain 透明
    """

    def __init__(self, file_bridge, ws_server: Optional[WsStateServer] = None):
        self.file = file_bridge
        self.ws = ws_server
        # Brain 日志里引用 bridge_path，保持兼容
        self.bridge_path = getattr(file_bridge, "bridge_path", None)

    def send(self, action: Dict[str, Any]) -> str:
        if self.ws and self.ws.connected and self.ws.send_command(action):
            return "ws"
        return self.file.send(action)

    def read_state(self) -> Dict[str, Any]:
        if self.ws and self.ws.connected and self.ws.latest_state:
            return self.ws.latest_state
        return self.file.read_state()

    def read_agent_player(self) -> Dict[str, Any]:
        state = self.read_state() or {}
        return state.get("agentPlayer") or {}
