"""分身农庄 - 运动冒烟测试：验证「自然语言/坐标 → 主玩家真实寻路移动」端到端闭环。

这是 Agent 开发的第一个里程碑验证工具：确认「我说需求 → 游戏人物动起来」真的跑通。

用法：
  python smoke_test.py                 # 自动挑一个附近可通行瓦片，寻路过去并轮询确认到达
  python smoke_test.py 65 15           # 指定目标瓦片 (x, y)
  python smoke_test.py "走到 65 15"     # 直接走一条自然语言指令（走 agent 的解析链路）

前置：
  星露谷已通过 SMAPI 启动并「载入存档进入世界」。此时新版 player-pilot MOD 会把
  agentPlayer 字段写入 bridge_data.json；若缺该字段，多半是存档没进世界或跑的是旧 MOD。
"""
from __future__ import annotations

import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from agent import ActionBridge, StardewAgent

POLL_TIMES = 20      # 轮询次数
POLL_INTERVAL = 0.5  # 每次间隔（秒）——与 MOD 的 0.5s 同步节奏对齐


def _cur_tile(state: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    """优先用 agentPlayer.tile，退化到 player.position(像素)/64。"""
    ap = (state or {}).get("agentPlayer") or {}
    t = ap.get("tile")
    if isinstance(t, dict) and "x" in t and "y" in t:
        return int(t["x"]), int(t["y"])
    pos = ((state or {}).get("player") or {}).get("position") or {}
    if "x" in pos and "y" in pos:
        return int(round(pos["x"] / 64.0)), int(round(pos["y"] / 64.0))
    return None


def _pick_target(state: Dict[str, Any], cur: Tuple[int, int]) -> Tuple[int, int]:
    """从 agentPlayer.surroundings 里挑一个「可通行、非水、离得最远」的瓦片当目标；
    拿不到周边信息就退化为向北 4 格。"""
    ap = (state or {}).get("agentPlayer") or {}
    tiles = ((ap.get("surroundings") or {}).get("tiles")) or []
    best: Optional[Tuple[int, int]] = None
    best_d = 1  # 至少要离开当前格
    for t in tiles:
        if not t.get("passable") or t.get("water"):
            continue
        d = abs(int(t["x"]) - cur[0]) + abs(int(t["y"]) - cur[1])
        if d > best_d:
            best_d, best = d, (int(t["x"]), int(t["y"]))
    return best if best else (cur[0], cur[1] - 4)


def _poll_until_arrive(bridge: ActionBridge, target: Tuple[int, int]) -> bool:
    """轮询 bridge_data.json，打印每一帧化身状态，直到到达目标或超时。"""
    arrived = False
    for i in range(POLL_TIMES):
        time.sleep(POLL_INTERVAL)
        ap = bridge.read_agent_player()
        tile = ap.get("tile") or {}
        tx, ty = tile.get("x"), tile.get("y")
        moving = ap.get("moving")
        mode = ap.get("mode")
        print(f"  [{i * POLL_INTERVAL + POLL_INTERVAL:4.1f}s] mode={mode} tile=({tx},{ty}) "
              f"moving={moving} target={target}")
        if tx is not None and abs(tx - target[0]) + abs(ty - target[1]) <= 1:
            arrived = True
            break
    return arrived


def main(argv: List[str]) -> int:
    bridge = ActionBridge()
    state = bridge.read_state()
    if not state:
        print("[FAIL] 读不到 bridge_data.json —— 游戏是否已启动并载入存档？")
        print(f"  期望路径: {bridge.bridge_path}")
        return 2

    if "agentPlayer" not in state:
        print("[WARN] bridge_data.json 缺少 agentPlayer 字段：")
        print("  可能存档还没进世界，或当前运行的是旧版 MOD（重新部署新 DLL 后再进世界）。")
        # 仍尝试执行，靠 player.position 估算当前格

    cur = _cur_tile(state)
    if cur is None:
        print("[FAIL] 无法确定主玩家当前瓦片坐标。")
        return 2

    # 目标：命令行指定 > 自然语言 > 自动挑选
    nl_mode = False
    if len(argv) >= 2 and argv[0].lstrip("-").isdigit() and argv[1].lstrip("-").isdigit():
        target = (int(argv[0]), int(argv[1]))
    elif len(argv) == 1 and not argv[0].lstrip("-").isdigit():
        nl_mode = True
        target = None  # 由自然语言解析决定
    else:
        target = _pick_target(state, cur)

    print(f"起点 tile={cur}  location={state.get('location')}  "
          f"stamina={(state.get('player') or {}).get('stamina')}")

    if nl_mode:
        agent = StardewAgent(bridge=bridge)
        res = agent.execute(argv[0])
        print(f"自然语言指令: {argv[0]}")
        print(f"解析动作: {res.get('actions')}")
        # 若解析出的是移动，抽出目标做到达判定
        for a in res.get("actions", []):
            if a.get("actionType") in ("player_move_to",):
                target = (a["x"], a["y"])
        if target is None:
            print("（该指令非移动类，跳过到达判定，仅观察状态）")
            _poll_until_arrive(bridge, cur)  # 打印几帧状态即可
            return 0
    else:
        print(f"下发 player_move_to → {target}")
        bridge.send({"actionType": "player_move_to", "x": target[0], "y": target[1]})

    ok = _poll_until_arrive(bridge, target)
    if ok:
        print(f"[OK] 到达目标附近 {target} —— 自然语言/坐标 → 人物运动 闭环打通。")
        return 0
    print(f"[FAIL] 超时未到达 {target}。排查：存档已进世界？库存里有对应工具？路径是否被完全阻挡？")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
