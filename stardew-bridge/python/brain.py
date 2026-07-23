"""分身农庄 - AI 大脑（autonomous agent · 真正的自主智能体）

真正的自主闭环（区别于「命令驱动」与「专注状态驱动」）：
    读游戏状态(bridge_data.json) → 决策 → 下发 player_* 动作 → 观察结果 → 循环。

两种决策后端：
  - LLM 大脑（--llm）：调用云端大模型（真实 API）做开放式决策，应对未预设的局面。
  - 启发式策略（默认）：基于状态/时间的规则自治，离线可跑，用于无 key 兜底与演示。

用法：
    python brain.py --check              # 只验证 LLM API 连通性（不控制游戏）
    python brain.py --once               # 启发式：跑一个「观察-决策-执行」周期
    python brain.py --once --llm         # LLM：跑一个周期（打印大模型的思考与动作）
    python brain.py                      # 启发式：持续自主运行
    python brain.py --llm                # LLM：持续自主运行
    python brain.py --llm --goal "先把成熟作物收完再去挖矿"

安全护栏：夜晚/低体力自动回家；每轮最多若干动作；轮次间隔；Ctrl-C 停止。
"""
from __future__ import annotations

import json
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple


def _load_dotenv() -> None:
    """在导入 config 前把同目录 .env 注入环境变量（密钥不入库）。"""
    import os
    from pathlib import Path

    p = Path(__file__).with_name(".env")
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

try:
    from loguru import logger
except Exception:  # pragma: no cover
    import logging

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    logger = logging.getLogger("brain")

from agent import ActionBridge
from ws_bridge import WsStateServer, HybridBridge

try:
    from config import config

    _LLM_KEY = config.llm_api_key
    _LLM_MODEL = config.llm_model
    _LLM_BASE = config.llm_base_url
    _LLM_MAXTOK = config.llm_max_tokens
    _LLM_TEMP = config.llm_temperature
except Exception:  # pragma: no cover
    import os

    _LLM_KEY = os.getenv("LLM_API_KEY", "")
    _LLM_MODEL = os.getenv("LLM_MODEL", "claude-sonnet-4-20250514")
    _LLM_BASE = os.getenv("LLM_BASE_URL", "https://api.anthropic.com")
    _LLM_MAXTOK = 1024
    _LLM_TEMP = 0.7

import os

_LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto")  # auto | anthropic | openai

# ============ 护栏参数 ============
NIGHT_TIME = 2400          # 过午夜(00:00 后)→回家准备睡觉
LOW_STAMINA_RATIO = 0.12   # 体力低于此比例→回家休息
DEFAULT_INTERVAL = 5.0     # 每轮间隔（秒）
MAX_ACTIONS_PER_STEP = 4   # 单轮最多下发的动作数
BRAIN_DECIDE_MAXTOK = 3000 # LLM 决策预算（gpt-5 等推理模型会消耗思考 token，需留足）
SEND_GAP = 0.06            # 动作间隔，保证文件名单调

FARMHOUSE = ("FarmHouse", 3, 11)
FARM = ("Farm", 64, 15)

# 当前 MOD 已实现的动作白名单（LLM 只能用这些）
ALLOWED_ACTIONS = {
    "player_move_to", "player_farm", "player_use_tool", "player_warp",
    "player_face", "player_interact", "player_attack", "player_stop", "player_idle",
    "player_sleep", "player_plant", "player_inspect", "chat",
    "player_select_item", "player_eat", "player_enter_door", "player_use_tool_repeat",
}


# ======================================================================
# 1. 状态摘要：把 bridge_data.json 压缩成决策所需的精炼上下文
# ======================================================================
def build_digest(state: Dict[str, Any]) -> Dict[str, Any]:
    """把庞大的 bridge_data.json 压缩成大模型/启发式好用的任务摘要。"""
    player = state.get("player") or {}
    ap = state.get("agentPlayer") or {}
    sur = ap.get("surroundings") or {}
    tiles = sur.get("tiles") or []

    harvest, water, clear = [], [], []
    for t in tiles:
        x, y = t.get("x"), t.get("y")
        if t.get("cropReady"):
            harvest.append({"x": x, "y": y, "crop": t.get("crop")})
        elif t.get("crop") and t.get("waterState") == 0:  # 0=干,1=已浇,-1=非耕地
            water.append({"x": x, "y": y, "crop": t.get("crop")})
        if t.get("breakable"):
            clear.append({"x": x, "y": y, "obj": t.get("obj")})

    max_st = ap.get("maxStamina") or 270
    st = player.get("stamina", ap.get("stamina", 0))
    inv = ap.get("inventory") or []
    seeds = [{"name": i.get("name"), "stack": i.get("stack")} for i in inv if i and i.get("isSeed")]
    edibles = [{"name": i.get("name"), "stack": i.get("stack")} for i in inv if i and i.get("edible")]
    return {
        "time": state.get("time"),
        "day": state.get("day"),
        "season": state.get("season"),
        "weather": state.get("weather"),
        "location": state.get("location"),
        "money": player.get("money"),
        "stamina": st,
        "maxStamina": max_st,
        "staminaPct": round(st / max_st, 2) if max_st else 0,
        "tile": ap.get("tile"),
        "mode": ap.get("mode"),
        "moving": ap.get("moving"),
        "tasks": {"harvest": harvest, "water": water, "clear": clear},
        "monsters": sur.get("monsters") or [],
        "seeds": seeds,
        "edibles": edibles,
        "currentTool": ap.get("currentTool"),
        "canMove": ap.get("canMove"),
        "lastResult": ap.get("lastCommandResult"),
    }


def _has_farm_work(d: Dict[str, Any]) -> bool:
    t = d.get("tasks") or {}
    return bool(t.get("harvest") or t.get("water") or t.get("clear"))


def _is_daytime(d: Dict[str, Any]) -> bool:
    tm = d.get("time") or 600
    return 600 <= tm < NIGHT_TIME


def _dedup_actions(actions: List[Dict[str, Any]], d: Dict[str, Any]) -> List[Dict[str, Any]]:
    """滤除会造成频闪/顿挫的冗余动作：
    - 已在目标场景就别再 warp（否则每次都深入深出黑屏渐变）；
    - 已在务农就别重发 player_farm（否则打断寻路造成跳步）。"""
    out = []
    cur_loc = d.get("location")
    mode = d.get("mode")
    for a in actions:
        t = a.get("actionType")
        if t == "player_warp" and a.get("location") == cur_loc:
            continue
        if t == "player_farm" and mode == "farm":
            continue
        out.append(a)
    return out


# ======================================================================
# 2. 启发式策略（无需 API key 的自治兜底）
# ======================================================================
class HeuristicPolicy:
    """基于「时间/体力/怪物/农活」的规则自治：能在没有大模型时也自动运转。"""

    name = "heuristic"

    def decide(self, d: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
        # 1) 安全优先：体力过低 → 有吃的先吃，没吃的回家
        if d.get("staminaPct", 1) <= LOW_STAMINA_RATIO:
            if d.get("edibles"):
                return ("体力见底，吃点东西回血", [{"actionType": "player_eat"}])
            return ("体力过低，回农舍休息", [_warp(*FARMHOUSE), {"actionType": "player_stop"}])

        # 2) 作息：过午夜 → 回家睡觉结束这一天（MOD 会自动传送回农舍并入睡推进到次日）
        if (d.get("time") or 0) >= NIGHT_TIME:
            return ("已过午夜，回家睡觉结束这一天", [{"actionType": "player_sleep"}])

        # 3) 战斗：附近有怪 → 靠近并攻击
        monsters = d.get("monsters") or []
        if monsters:
            m = monsters[0]
            return (f"附近有怪物 {m.get('name')}，先清理",
                    [{"actionType": "player_move_to", "x": m.get("x"), "y": m.get("y")},
                     {"actionType": "player_attack"}])

        # 4) 农活：附近有可收/待浇/杂物 → 进入自主务农（MOD 会全场扫描最近任务）
        if _has_farm_work(d):
            if d.get("mode") != "farm":
                return ("发现农活，进入自主务农模式", [{"actionType": "player_farm"}])
            return ("持续自主务农中", [])

        # 5) 不在农场且是白天 → 回农场找活
        if d.get("location") != "Farm" and _is_daytime(d):
            return ("附近无农活，回农场巡查", [_warp(*FARM)])

        # 6) 在农场但周边无活 → kick 一次 farm 让 MOD 全场重扫
        if d.get("mode") != "farm":
            return ("巡场找活", [{"actionType": "player_farm"}])
        return ("暂无新任务，保持自主务农", [])


def _warp(loc: str, x: int, y: int) -> Dict[str, Any]:
    return {"actionType": "player_warp", "location": loc, "x": x, "y": y}


# ======================================================================
# 3. LLM 客户端（OpenAI 兼容 / Anthropic 双协议，真实 API 调用）
# ======================================================================
class LLMClient:
    """极简大模型客户端：一个 chat(system,user)->text，自动适配两大主流协议。"""

    def __init__(self, key: str = _LLM_KEY, model: str = _LLM_MODEL,
                 base_url: str = _LLM_BASE, provider: str = _LLM_PROVIDER):
        self.key = key
        self.model = model
        self.base_url = (base_url or "").rstrip("/")
        self.provider = self._resolve_provider(provider)

    def _resolve_provider(self, p: str) -> str:
        if p and p != "auto":
            return p
        b = (self.base_url or "").lower()
        if "anthropic" in b or (self.model or "").lower().startswith("claude"):
            return "anthropic"
        return "openai"

    def available(self) -> bool:
        return bool(self.key)

    def chat(self, system: str, user: str, max_tokens: int = _LLM_MAXTOK) -> str:
        import urllib.request

        if self.provider == "anthropic":
            url = self.base_url + "/v1/messages"
            body = {
                "model": self.model, "max_tokens": max_tokens,
                "temperature": _LLM_TEMP, "system": system,
                "messages": [{"role": "user", "content": user}],
            }
            headers = {
                "content-type": "application/json",
                "x-api-key": self.key,
                "anthropic-version": "2023-06-01",
                "user-agent": "Mozilla/5.0",
                "accept": "*/*",
            }
        else:  # openai 兼容
            url = self.base_url + "/v1/chat/completions"
            body = {
                "model": self.model, "max_tokens": max_tokens,
                "temperature": _LLM_TEMP,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }
            headers = {
                "content-type": "application/json",
                "authorization": f"Bearer {self.key}",
                "user-agent": "Mozilla/5.0",
                "accept": "*/*",
            }

        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())

        if self.provider == "anthropic":
            return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        return (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""


_SYSTEM_PROMPT = """你是《星露谷物语》主玩家(Game1.player)的自主 AI 大脑。你会不断收到当前游戏状态的 JSON 摘要，
需要据此自主决定「接下来做什么」，目标是像一个勤劳的农夫一样高效经营农场。

总目标：{goal}

可用动作（只能用这些，字段必须齐全）：
- {{"actionType":"player_farm"}}  进入自主务农：MOD 会自动扫描全场并就近收割/浇水/播种(背包有种子时)/锄地/清杂物，且都是先走到旁边再动手（做批量农活的首选）
- {{"actionType":"player_move_to","x":int,"y":int}}  寻路到瓦片
- {{"actionType":"player_use_tool","tool":"pickaxe|axe|hoe|watering_can|sword","x":int,"y":int}}  用工具（会先走到目标旁再挥）：挖矿石/砍树/锄地
- {{"actionType":"player_plant","x":int,"y":int,"seed":"可选种子名"}}  走到指定耕地旁播种（不指定则用背包第一个种子）
- {{"actionType":"player_inspect","x":int,"y":int}}  查看指定瓦片详情（省略则看面前一格），结果在下一轮 lastResult 里
- {{"actionType":"player_warp","location":"Farm|FarmHouse|Town|Mine","x":int,"y":int}}  传送
- {{"actionType":"player_attack"}}  挥武器攻击当前朝向
- {{"actionType":"player_interact","x":int,"y":int}}  交互/开箱/收获
- {{"actionType":"player_face","direction":0}}  0上1右2下3左
- {{"actionType":"player_eat"}}  吃掉快捷栏里第一个可食物品回体力（可带 "slot":0-11 指定）
- {{"actionType":"player_select_item","slot":0}}  切换快捷栏选中格（0-11）
- {{"actionType":"player_use_tool_repeat","count":5}}  原地连续挥当前工具 N 次（矿洞清场/整地）
- {{"actionType":"player_enter_door"}}  走进面前的门/传送点（进出建筑、下矿层）
- {{"actionType":"player_sleep"}}  回农舍上床睡觉、结束当天并推进到第二天（会自动传送回家）
- {{"actionType":"player_stop"}}  停止待命
- {{"actionType":"chat","metadata":{{"message":"..."}}}}  在游戏里说一句话（用于说明或暂不支持的操作）

决策原则：
1. 体力(staminaPct)过低：背包有可食物品(见 edibles)先 player_eat 吃东西；没有再回 FarmHouse 休息。已过午夜(time>=2400) → player_sleep 睡觉结束当天。
2. 附近有怪物 → 先靠近再 player_attack。
3. 有成熟作物/待浇水/杂物 → 优先 player_farm 让化身自动干活。
4. 农场没活了可去矿洞：player_use_tool 逐格敲矿，或选中镐子后 player_use_tool_repeat 连挥；走到楼梯口用 player_enter_door 下一层。
5. 背包里的种子见 seeds 字段；空耕地可直接 player_plant 或交给 player_farm。
6. 购买/酿酒等 MOD 暂未内建的复杂操作，用 chat 说明，别臆造未列出的 actionType。

严格只输出一个 JSON 对象，不要解释、不要代码块围栏：
{{"thought":"一句话说明你的判断","actions":[ 动作对象, ... ]}}
actions 建议 1~3 个，可为空数组表示继续观察。"""


class LLMBrain:
    """LLM 决策后端：状态摘要 → 大模型 → JSON 动作。失败自动回退启发式。"""

    name = "llm"

    def __init__(self, goal: str, client: Optional[LLMClient] = None):
        self.client = client or LLMClient()
        self.goal = goal
        self.fallback = HeuristicPolicy()
        self.history: List[str] = []

    def decide(self, d: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
        if not self.client.available():
            t, a = self.fallback.decide(d)
            return (f"[无API key，启发式] {t}", a)
        system = _SYSTEM_PROMPT.format(goal=self.goal)
        user = "当前状态:\n" + json.dumps(d, ensure_ascii=False)
        if self.history:
            user += "\n\n最近几步:\n" + "\n".join(self.history[-3:])
        try:
            raw = self.client.chat(system, user, max_tokens=BRAIN_DECIDE_MAXTOK)
            thought, actions = _parse_decision(raw)
            self.history.append(f"想法:{thought} 动作:{[a.get('actionType') for a in actions]}")
            return thought, actions
        except Exception as e:
            logger.warning(f"LLM 决策失败，回退启发式：{e}")
            t, a = self.fallback.decide(d)
            return (f"[LLM失败回退] {t}", a)


def _parse_decision(raw: str) -> Tuple[str, List[Dict[str, Any]]]:
    """从大模型输出里抽出 {"thought","actions"}，并过滤非法 actionType。"""
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return ("(无法解析大模型输出)", [])
    obj = json.loads(m.group(0))
    thought = str(obj.get("thought", ""))
    actions = []
    for a in (obj.get("actions") or []):
        if isinstance(a, dict) and a.get("actionType") in ALLOWED_ACTIONS:
            actions.append(a)
    return thought, actions


# ======================================================================
# 4. 自主循环
# ======================================================================
class Brain:
    def __init__(self, backend, bridge: Optional[ActionBridge] = None):
        self.backend = backend
        if bridge is None:
            file_bridge = ActionBridge()
            ws_server = WsStateServer(config.ws_host, config.ws_port)
            ws_server.start()  # 库缺失/端口占用时静默回退文件桥
            bridge = HybridBridge(file_bridge, ws_server)
        self.bridge = bridge

    def step(self) -> bool:
        """一个「观察-决策-执行」周期。返回 False 表示读不到状态。"""
        state = self.bridge.read_state()
        if not state:
            logger.error(f"读不到 bridge_data.json（游戏是否已进世界？）: {self.bridge.bridge_path}")
            return False
        if "agentPlayer" not in state:
            logger.warning("bridge_data.json 无 agentPlayer：存档未进世界或运行了旧版 MOD")

        d = build_digest(state)
        thought, actions = self.backend.decide(d)
        actions = _dedup_actions(actions, d)
        logger.info(f"[{self.backend.name}] think: {thought} | "
                    f"time={d.get('time')} loc={d.get('location')} "
                    f"stamina={d.get('staminaPct')} tasks="
                    f"H{len(d['tasks']['harvest'])}/W{len(d['tasks']['water'])}/C{len(d['tasks']['clear'])}")
        for a in actions[:MAX_ACTIONS_PER_STEP]:
            self.bridge.send(a)
            time.sleep(SEND_GAP)
        return True

    def run(self, interval: float = DEFAULT_INTERVAL, once: bool = False):
        logger.info(f"AI 大脑启动（后端={self.backend.name}，间隔={interval}s）。Ctrl-C 停止。")
        try:
            while True:
                ok = self.step()
                if once:
                    break
                time.sleep(interval if ok else max(interval, 3))
        except KeyboardInterrupt:
            logger.info("已停止 AI 大脑。")


# ======================================================================
# 5. CLI
# ======================================================================
def _check_api() -> int:
    client = LLMClient()
    print(f"provider={client.provider}  model={client.model}  base={client.base_url}")
    if not client.available():
        print("[FAIL] 未配置 LLM_API_KEY —— 请在 .env 填入真实 key（当前为空/占位）。")
        return 2
    try:
        reply = client.chat("你是连通性测试助手。", "只回复两个字：在线", max_tokens=16)
        print(f"[OK] LLM API 连通，返回: {reply.strip()[:80]}")
        return 0
    except Exception as e:
        print(f"[FAIL] LLM API 调用失败: {e}")
        return 1


def main(argv: List[str]) -> int:
    use_llm = "--llm" in argv
    once = "--once" in argv
    check = "--check" in argv

    goal = "高效经营农场：优先收获成熟作物、给缺水作物浇水、清理杂物；农场无活则去矿洞挖矿。"
    if "--goal" in argv:
        i = argv.index("--goal")
        if i + 1 < len(argv):
            goal = argv[i + 1]
    interval = DEFAULT_INTERVAL
    if "--interval" in argv:
        i = argv.index("--interval")
        if i + 1 < len(argv):
            try:
                interval = float(argv[i + 1])
            except ValueError:
                pass

    if check:
        return _check_api()

    backend = LLMBrain(goal=goal) if use_llm else HeuristicPolicy()
    Brain(backend).run(interval=interval, once=once)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
