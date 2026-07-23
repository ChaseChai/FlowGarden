"""分身农庄 - 编排器 + Agent (P3, player_* 驾驶版)

核心：现实状态/语音事件 → 映射策略 → 翻译成 player_* 桥接指令，直接驾驶主玩家 Game1.player。
不再生成 shadow farmer / companion——玩家本人的化身就是分身。
"""
import asyncio
import random
import time
from typing import Optional, Dict, Any

from loguru import logger

from config import config
from event_bus import event_bus, FarmEvent
from state_engine import state_engine
from mapping import get_strategy, BehaviorStrategy, FARM, WANDER, IDLE, SLEEP
from agent import ActionBridge, IntentParser


class GamePilot:
    """把语义动作翻译成 player_* 桥接指令，直接驱动主玩家。"""

    # 已知安全落点（location, x, y）
    FARMHOUSE = ("FarmHouse", 3, 11)

    def __init__(self):
        self.bridge = ActionBridge()
        self.parser = IntentParser(use_llm=bool(config.llm_api_key))

    # --- 状态读取 ---
    def state(self) -> Dict[str, Any]:
        return self.bridge.read_state()

    def agent_player(self) -> Dict[str, Any]:
        return self.bridge.read_agent_player()

    def money(self) -> int:
        return (self.state().get("player") or {}).get("money", 0)

    def _tile(self) -> tuple:
        t = (self.agent_player().get("tile") or {})
        return int(t.get("x", 64)), int(t.get("y", 15))

    # --- 语义动作 → player_* ---
    def farm(self):
        """自主务农。仅在化身未处于 farm 模式时重新 kick，避免打断正在进行的动作。"""
        if self.agent_player().get("mode") != "farm":
            self.bridge.send({"actionType": "player_farm"})

    def wander(self):
        """无目的闲逛：朝当前位置附近的随机格走动，不推进生产。"""
        x, y = self._tile()
        nx, ny = x + random.randint(-4, 4), y + random.randint(-4, 4)
        self.bridge.send({"actionType": "player_move_to", "x": nx, "y": ny})

    def idle(self):
        """停下待命 / 力竭站立。"""
        self.bridge.send({"actionType": "player_stop"})

    def sleep(self):
        """回家睡觉：下发 player_sleep，MOD 会自动传送回农舍、入床并推进到第二天。
        （早期版本仅传送回家不入睡；现 MOD 已实现真正的结束当天）。"""
        self.bridge.send({"actionType": "player_sleep"})

    def voice(self, text: str):
        """语音指令：复用 Agent 的意图解析器，NL → player_* 动作序列。"""
        actions = self.parser.parse(text)
        for a in actions:
            self.bridge.send(a)
            time.sleep(0.05)
        return actions

    # 语义动作分发表
    def execute_move(self, move: str):
        {FARM: self.farm, WANDER: self.wander, IDLE: self.idle, SLEEP: self.sleep} \
            .get(move, self.idle)()


class Orchestrator:
    """编排器：现实事件 → 策略 → 主玩家动作"""

    def __init__(self):
        self.pilot = GamePilot()
        self._current_strategy: Optional[BehaviorStrategy] = None
        self._focus_start_gold: int = 0
        self._last_action_ts: float = 0
        self._running = False
        self._action_task: Optional[asyncio.Task] = None

    async def start(self):
        event_bus.subscribe("focus_start", self._on_focus_start)
        event_bus.subscribe("rest", self._on_rest)
        event_bus.subscribe("distracted", self._on_distracted)
        event_bus.subscribe("sleep", self._on_sleep)
        event_bus.subscribe("voice_cmd", self._on_voice_cmd)
        event_bus.subscribe("tick", self._on_tick)

        self._running = True
        self._action_task = asyncio.create_task(self._action_loop())
        logger.info("编排器已启动（纯玩家驾驶模式）")

    async def stop(self):
        self._running = False
        if self._action_task:
            self._action_task.cancel()

    # === 事件处理 ===

    async def _on_focus_start(self, event: FarmEvent):
        self._focus_start_gold = self.pilot.money()
        self._update_strategy()
        self.pilot.farm()  # 立即开工
        await event_bus.publish(FarmEvent(type="feedback", data={
            "msg": "专注开始！你的化身开始高效耕作。",
            "positive": True,
        }))

    async def _on_rest(self, event: FarmEvent):
        duration = event.data.get("duration", 0)
        delta = self.pilot.money() - self._focus_start_gold
        self._update_strategy()
        self.pilot.idle()  # 停手，进入维持
        await event_bus.publish(FarmEvent(type="feedback", data={
            "msg": f"专注 {duration/60:.0f} 分钟，农场收益 +{delta}g",
            "positive": True,
            "gold_delta": delta,
        }))

    async def _on_distracted(self, event: FarmEvent):
        self._update_strategy()
        count = event.data.get("distraction_count", 0)
        if count >= 3:
            self.pilot.idle()  # 长期分心：彻底停手，作物无人浇水而干枯
            await event_bus.publish(FarmEvent(type="feedback", data={
                "msg": f"你已分心 {count} 次，化身停下了——作物开始缺水枯萎。回来专注吧。",
                "positive": False,
            }))

    async def _on_sleep(self, event: FarmEvent):
        self.pilot.sleep()
        self._update_strategy()

    async def _on_voice_cmd(self, event: FarmEvent):
        """语音指令 → Agent 意图解析 → player_* 指令。"""
        cmd = event.data.get("text", "")
        logger.info(f"语音指令: {cmd}")
        actions = self.pilot.voice(cmd)
        logger.info(f"语音 → {[a.get('actionType') for a in actions]}")

    async def _on_tick(self, event: FarmEvent):
        self._update_strategy()

    def _update_strategy(self):
        self._current_strategy = get_strategy(
            state_engine.state.mode,
            state_engine.state.efficiency,
            state_engine.state.distraction_count,
        )

    # === 动作执行循环 ===

    async def _action_loop(self):
        """按策略定时下发游戏动作，节奏随 efficiency 缩放。"""
        while self._running:
            try:
                if self._current_strategy and self._current_strategy.moves:
                    move = self._current_strategy.moves[0].move  # 取最高优先级
                    interval = self._current_strategy.action_interval_sec
                else:
                    move = None
                    interval = config.idle_action_interval_sec

                # SLEEP 为一次性动作（已在 _on_sleep 里下发），循环中不重复刷屏
                if move and move != SLEEP:
                    self.pilot.execute_move(move)
                    self._last_action_ts = time.time()
                    wait = interval
                else:
                    wait = config.idle_action_interval_sec

                await asyncio.sleep(max(wait, 1))
            except Exception as e:
                logger.error(f"动作循环异常: {e}")
                await asyncio.sleep(5)


# 全局单例
orchestrator = Orchestrator()
