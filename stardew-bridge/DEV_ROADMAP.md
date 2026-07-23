# 分身农庄 Avatar Farm · 剩余开发 PRD 规划与集成实施方案（v2）

> 工作代号 **Stardew Ring Bridge** · AdventureX 2026
> 本文是**前瞻性开发规划**：承接 [PRD.md](./PRD.md)（需求真源）与 [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md)（现状快照），
> 聚焦「**还要做什么 · 怎么排期 · 戒指怎么接 · 前端怎么做 · 如何总装**」。
> 五大块：A 已完成总结 · B 剩余 P1–P5 PRD · C 时间线 · D 戒指对接 · E 前端小工具 · F 综合总装。

---

## A. 已完成工作全面总结

### A.1 P0 基座打通 ✅
- fork `amarisaster/StardewValley-MCP`（MIT）clone 到 `vendor/`；Node MCP Server `npm run build` 通过。
- 通信基座跑通：**MCP Server ↔ SMAPI 走本地 JSON 文件**——`bridge_data.json`（游戏回读状态）+ `actions/*.json`（命令队列，原子写 tmp→rename、读后即删）。
- 环境锁定：SMAPI 4.5.2 + 星露谷 1.6.15 + Windows 11 + .NET 6 + Node 18+ + Python 3.11。

### A.2 SMAPI MOD 部署（架构已转向「直接驾驶主玩家」）✅（⚠️ 新 DLL 待部署）
- **重大转向**：从上游「隐形 shadow Farmer + companion NPC」→ **直接驾驶 `Game1.player` 主玩家**（无需贴图/NPC 配对/影子同步）。删 companion 相关 5 文件。
- 重写 `ModEntry.cs`：`actionType.StartsWith("player_")` 路由到 `PlayerPilot`。
- `PlayerPilot.cs`（~426 行）：`Tick()` 每帧 `PathFindController` + 到达检测(dist≤1.5) + 卡住(120tick)重定位；`HandleCommand` 分发 `player_move_to/farm/use_tool/warp/face/interact/attack/stop/idle`；`GetStatus()` 回写 `agentPlayer`（mode∈{idle,manual,farm}）。
- **状态**：编译通过，产物在 `bin/Release/net6.0/`；**因游戏运行锁 DLL，两次部署失败，尚未部署实测**（唯一硬阻塞）。

### A.3 Agent 基础接口实现 ✅
- `agent.py`（~348 行）：`ActionBridge`（原子写 actions）+ `IntentParser`（规则优先、云 LLM 兜底）+ `StardewAgent` 门面 + CLI REPL。
- 规则映射覆盖：浇水/收割/移动/工具/采矿/钓鱼/传送 → `player_*`；LLM 兜底走 Anthropic `/v1/messages`（`config.llm_*`）。
- **离线验证**：15 条自然语言用例 → `player_*` 映射全部正确。

### A.4 现实状态 → 游戏行为映射表 ✅
- `state_engine.py`：focus/rest/distracted/sleep 四态 + `efficiency∈[0,1]`（随专注时长/streak 提升）。
- `mapping.py`：语义动作 `FARM/WANDER/IDLE/SLEEP` + `BehaviorStrategy`；`get_strategy(mode, efficiency, distraction_count)`——distracted 累计≥3 切 `negative`；`copy.copy` 防模板污染；productive 按 efficiency 缩放下发节奏。
- `orchestrator.py`：`GamePilot` 语义→`player_*` 文件（farm 仅 `mode!="farm"` 才重发；wander tile±4 随机；sleep=warp FarmHouse+stop；voice 走 IntentParser）。
- **离线验证**：DEMO 干跑产出 8 个 `player_*` 动作文件全部正确。

### A.5 配套齐备 ✅
`ring_bridge.py`（BLE 监听 + demo 兜底）、`feedback.py`（金币/体力监控 + PowerShell TTS）、`main.py`（全链路启动）、`event_bus.py`、`config.py`（含 `ring_mac / llm_* / stt_* / ws_port=8765 / demo_mode`）。

> **一句话现状**：现实→映射→动作→反馈的 Python 全链路已成型并离线验证；**唯一阻塞是新 MOD DLL 未部署到运行中的游戏**。部署后即可打通首个游戏内闭环。

---

## B. 剩余开发 PRD 规划（P1–P5 实现路径）

> 里程碑编号沿用 PRD §9。下面给每个阶段：**目标 → 具体实现路径 → 验收标准**。

### P0.5 · 部署与首个游戏内闭环（最高优先，解阻塞）
- **目标**：让 `player_*` 在游戏里真正生效。
- **路径**：① 彻底关游戏到桌面 → ② `cd vendor/smapi-mod && set GAME_PATH=... && dotnet build -c Release`（ModBuildConfig 自动部署到 Mods）→ ③ 清理 Mods 里旧 companion 贴图残留 → ④ 进世界，用 `python agent.py "去浇水"` 或直接写 `actions/`，回读 `bridge_data.json.agentPlayer` 验证移动/农活。
- **验收**：SMAPI 控制台无红错；分身在农场执行 `player_farm`；金币/体力有变化。

### P1 · 戒指桥接 + 语音链路闭合
- **目标**：真戒指双击进专注、语音下指令端到端可用。
- **路径**：
  - 双击链路已就绪（`wait_sensor_key_double_press_event` → `double_tap` 事件 → state_engine 切 focus/rest）。真机联调断线退避重连 + 电量守卫（`battery_percent<20` 拒绝）。
  - **补 STT 环节（当前缺口）**：新增 `stt.py` worker 订阅 `voice_recorded{wav_path}` → 云 Whisper（`config.stt_*`）→ 文本 → 发布 `voice_cmd{text}` → orchestrator 已订阅 → `IntentParser` → `player_*`。
- **验收**：戴戒指双击 → 游戏进专注种地；长按说「去钓鱼」→ 分身切钓鱼。

### P1.5 · 日程调度模块 scheduler.py（闭环叙事核心）
- **目标**：现实日程 ↔ 游戏农活双向绑定 + 流动重排 + 主动干预 + **拖延惩罚**。
- **路径**（详见 PROJECT_OVERVIEW §6）：新增 `scheduler.py`，`ScheduledTask/Plan` 数据模型；订阅 `tick/focus_start/distracted/voice_cmd`；判定 `on_schedule/behind/overdue`；`slipped` → 顺延重排 + 生成建议事件给 feedback + 叠加惩罚系数给 `mapping.get_strategy`；被跳过的 chore 不下发 → 游戏侧自然「没做」（作物缺水、动物没喂）。
- **验收**：到点没专注 → 分身停工、对应作物进入缺水；重排建议经 TTS/HUD 推送。

### P2 · 精确操控扩展（补齐农活词表）
- **目标**：挖矿/钓鱼/酿酒/喂养可用，效率结算精确。
- **路径**（移植上游 `CompanionFarmer/CompanionAI` 算法到 `PlayerPilot.cs`）：
  - `player_use_tool` 后补 `checkForExhaustion(oldStamina)`（当前缺，导致体力不结算）。
  - `player_mine`：打怪→敲石(Stone 用镐)→找 Ladder/Shaft 站上→`MineShaft` warp 下层。
  - `player_fish`：`rod.beginUsing`→每帧 `rod.tickUpdate`→`isNibbling` 时 `rod.DoFunction`；**真玩家会弹 `BobberBar` 小游戏，需 MOD 内每帧自动完成**（不能走桥接往返）。
  - 酿酒：`interact` kegs 装填；喂养：进畜棚放草料（新增 chore 分发）。
- **验收**：`player_mine/fish` 稳定产出矿石/鱼；工具使用后体力正确下降；酿酒/喂养可触发。

### P3 · 反馈闭环精化
- **目标**：正负反馈叙事完整。
- **路径**：`feedback.py` 去除遗留 `companions` 字段、改读 `agentPlayer`；专注结算文案（"专注 N 分钟，农场丰收 XXXg"）；负反馈（缺水/枯萎/体力耗尽提醒）；接入 WebSocket 推送前端（见 E）。
- **验收**：结束专注有金币结算播报；分心过久有负反馈。

### P4 · 前端专注小工具（见 E 详设）
- **目标**：可视化专注状态 / 游戏进度 / 戒指连接 / 日程。
- **验收**：HUD 实时反映现实状态 + 分身农活 + 戒指连接 + 待办进度。

### P5 · 稳定性与演示保障
- **目标**：现场抗抖动。
- **路径**：watchdog（ring/bridge/MCP/game 四层健康 → safe-idle）；Agent 护栏（工具白名单 + 每分钟限速 + 超时重试）；**演示兜底脚本**（无戒指/无游戏回放 focus→distracted→sleep 叙事，`demo_mode` 已具雏形）；全链路日志。
- **验收**：断网/断戒指/游戏卡顿任一发生，系统不崩、可降级演示。

---

## C. 开发时间线（结合当前进度）

> 黑客松节奏，按**半天为块**排。红线：**演示兜底脚本任何时候都优先可用**（`demo_mode` 已具雏形，先补全）。

| 时段 | 任务 | 产出 | 依赖 |
| --- | --- | --- | --- |
| **D1 上午** | P0.5 部署 + 首个游戏内闭环 | player_farm/move/tool 游戏内生效 | 关游戏 |
| **D1 下午** | P1 STT worker + 语音闭合；双击真机联调 | 语音「去X」端到端 | P0.5 |
| **D2 上午** | P1.5 scheduler 最小闭环（计划 vs 实际 → 惩罚系数） | 拖延→分身耽误可见 | 映射层 |
| **D2 下午** | P2 checkForExhaustion + player_mine/fish | 挖矿/钓鱼可用 | P0.5 |
| **D3 上午** | P4 前端 HUD（WebSocket + 卡片） | 可视化面板 | P3 推送 |
| **D3 下午** | P3 反馈精化 + P1.5 流动重排/主动干预建议 | 正负反馈 + 重排提示 | scheduler |
| **D4 上午** | P2 酿酒/喂养 chore + scheduler 类别绑定补全 | §6.5 映射表补齐 | P2/P1.5 |
| **D4 下午** | P5 watchdog + 护栏 + **演示兜底彩排** | 完整可演示链路 | 全部 |
| **机动缓冲** | 贯穿 | 兜底脚本随时可回放 | — |

**并行建议**：前端 HUD（E）与游戏侧精控（P2）互不依赖，可两人并行；scheduler（P1.5）逻辑纯 Python，可脱机先写单测。

---

## D. Agent 与硬件戒指对接方案

> 戒指定位「哑终端」（PRD §5）：只输出**双击开关 + 语音**两种最小原语，复杂决策全在上位机。SDK = `ring_sound.py`（BLE/NUS，v4 协议）。

### D.1 BLE 通信层（ring_bridge.py，已实现）
- `bleak` 按 MAC 连接（`config.ring_mac`，默认 `F1:C1:8A:35:40:FB`）；`scan_rings(mac)` → `RingSoundClient(address)` async 上下文。
- **断线自愈**：`reconnect_max=5` 次指数退避（`backoff_base * 2^n`）。
- **电量守卫**：SDK 帧含 `battery_percent/battery_charging`；`<20%` 拒绝录音/手势（协议硬约束）。
- **兜底**：`demo_mode=1` 跳过真连，走 `main.demo_loop` 模拟事件。

### D.2 双击专注开关（已就绪）
- **只用双击 `0x0703`（`KEY_DOUBLE_PRESS`）**：排他事件、**不翻转设备模式** → 干净离散开关。
- **禁用单击 `0x0704`**：会尝试翻转录音/手势模式，有副作用，不用于状态切换。
- 链路：`wait_sensor_key_double_press_event(client)` → 发布 `double_tap` → **state_engine 内部翻转** focus_start ⇄ focus_end(rest)（同一物理动作按当前态决定语义）。

### D.3 语音指令处理（缺 STT 环节，P1 补齐）
```
长按录音(默认录音模式) → receive_auto_audio_file(client) 得 WAV bytes
  → save_audio_bundle(file_index, data, "audio")  → 发布 voice_recorded{wav_path}
  → [新增 stt.py] 订阅 voice_recorded → 云 Whisper(config.stt_*) → 文本
  → 发布 voice_cmd{text}
  → orchestrator._on_voice_cmd → GamePilot.voice(text)
  → IntentParser.parse (规则/LLM) → player_* 动作文件 → 游戏执行
```
- **模式互斥约束**：录音模式与手势/IMU 模式互斥，且**无法程序查询/切换**（仅物理按键，尽力而为）→ 睡眠检测走**时间窗启发式**（`sleep_window 22:00–07:00` + 静默），不依赖 IMU。
- **并发约束**：同一 BLE 连接不可并发消费队列 → `ring_bridge` 用 `asyncio.gather` 分离双击/录音两条监听协程，各自独立 try/重试。

### D.4 Agent 集成契约（事件总线）
| 事件 | 发布者 | 订阅者 | 语义 |
| --- | --- | --- | --- |
| `double_tap` | ring_bridge | state_engine | 专注开关翻转 |
| `voice_recorded{wav_path}` | ring_bridge | **stt.py（待建）** | 待转写录音 |
| `voice_cmd{text}` | stt.py | orchestrator | 语音指令文本 |
| `focus_start/rest/distracted/sleep` | state_engine | orchestrator/scheduler/feedback | 现实状态变更 |
| `tick` | state_engine | scheduler/feedback | 周期心跳 |
| `feedback{msg,positive}` | scheduler/orchestrator | feedback | 用户可感知反馈 |

---

## E. 专注前端界面小工具设计

### E.1 定位与技术选型
- **定位**：轻量 **HUD 悬浮面板**，专注时展示「现实状态 + 分身农活 + 戒指连接 + 日程进度」，弱化数字、强调「看得见的耕作」叙事。
- **技术**：复用 `archive/garden-web` 的**零构建**栈（HTML + CSS + gsap，可选 Three.js 花园虚化背景），承接镜园 §11「专注工作台」视觉（毛玻璃卡片 + 花园模糊背景 + 金色计时）。
- **数据通道**：Python 侧新增 **WebSocket 推送**（复用 `config.ws_host/ws_port=8765`），每 tick 推一帧状态 JSON；前端只读渲染，不回控（控制权仍在戒指/语音）。

### E.2 推送数据结构（Python → 前端）
```json
{
  "ring":  {"connected": true, "battery": 78},
  "real":  {"mode": "focus", "efficiency": 0.82, "focus_elapsed_sec": 2538, "distraction_count": 1},
  "game":  {"gold": 1240, "stamina": 210, "location": "Farm", "chore": "watering", "day_time": 1430},
  "schedule": [
    {"title": "写论文", "planned": "14:00", "status": "in_progress", "chore": "watering"},
    {"title": "复习数学", "planned": "16:00", "status": "pending", "chore": "harvest"}
  ],
  "feedback": {"msg": "专注 42 分钟，农场丰收 320g", "positive": true}
}
```

### E.3 面板布局（承接镜园 §11 工作台）
```
┌───────────────────────────────────────────────┐
│ 顶栏: ● 戒指 78%  |  专注中 42:18  |  🕐游戏14:30 │  ← 戒指连接+电量 / 专注计时 / 游戏时间
├──────────────┬────────────────┬────────────────┤
│ 📋 今日日程   │  🌾 分身此刻    │  🌱 农场镜像    │
│ ☑ 写论文·浇水  │  正在浇水...    │  作物 健康 12   │
│ ☐ 复习·收菜    │  金币 1240g     │  缺水 ⚠️ 3      │
│ ☐ 运动·挖矿    │  体力 ▓▓▓░ 210  │  枯萎 0         │
│ 💡建议:挪到午休 │  效率 0.82      │                │
├──────────────┴────────────────┴────────────────┤
│ 💬 反馈流: "专注 42 分钟，农场丰收 320g"          │  ← TTS 文案同步滚动
└───────────────────────────────────────────────┘
[背景: 花园强模糊 + 金色丁达尔光束(承接镜园休息态视觉)]
```

### E.4 关键组件与交互
| 组件 | 数据源 | 表现 |
| --- | --- | --- |
| **戒指连接灯** | `ring.connected/battery` | ●绿=已连 / ○红=断开；电量<20% 橙色闪烁 |
| **专注计时器** | `real.focus_elapsed_sec` | 大号金色数字，深度心流呼吸脉动；分心时转灰 |
| **分身农活卡** | `game.chore/gold/stamina` | 图标+文案「正在浇水/挖矿…」；体力条；金币增量高亮 |
| **日程/待办** | `schedule[]` | 完成划线；`slipped` 标红；`💡建议` 淡入 [采用]/[忽略] |
| **农场镜像** | `game` 作物统计 | 缺水/枯萎告警数（负反馈可视化） |
| **反馈流** | `feedback` | 与 TTS 同步的流式文字 |

### E.5 落地最小版（黑客松够用）
- 先做**单文件 HTML + 原生 WS 客户端**，读 E.2 的 JSON 渲染四张卡片，不追求花园 3D 背景。
- 本地起静态服务（复用旧 `garden-web` 端口 8823 或 python `http.server`），HUD 页连 `ws://localhost:8765`。
- 有余力再叠加镜园花园虚化背景与 gsap 进场动画。

---

## F. 综合集成实施方案（总装顺序）

**串起来的一条命令流**（部署后）：
```
戒指双击 →(BLE)→ ring_bridge:double_tap →(bus)→ state_engine:focus_start
  → scheduler(计划vs实际,惩罚系数) → mapping.get_strategy → orchestrator.GamePilot
  → actions/*.json →(MCP/文件)→ PlayerPilot →(游戏原生API)→ Game1.player 种地
  → bridge_data.json.agentPlayer →(回读)→ feedback:金币/体力增量
  → TTS 播报 + WebSocket 推 → 前端 HUD 刷新
语音「去钓鱼」→ ring_bridge:voice_recorded → stt.py:voice_cmd → orchestrator.voice → IntentParser → player_fish
```

**总装推进顺序（强依赖优先）**：
1. **解阻塞**：关游戏 → 部署新 DLL → 游戏内实测三基础动作（P0.5）。
2. **闭合输入**：STT worker 补齐语音链路（P1）；真戒指联调。
3. **闭环叙事**：scheduler 最小闭环——拖延→分身耽误（P1.5）。
4. **补农活**：checkForExhaustion + player_mine/fish + 酿酒/喂养（P2）。
5. **可视化**：WebSocket 推送 + 前端 HUD（P3/P4）。
6. **上保险**：watchdog + 护栏 + 演示兜底彩排（P5）。

**风险与对策**：
| 风险 | 对策 |
| --- | --- |
| 游戏运行锁 DLL，部署反复失败 | 部署脚本前置「确认游戏已关」检查；固定「关→编译→启」流程 |
| 真玩家钓鱼弹 BobberBar | MOD 内每帧自动完成小游戏，绝不走桥接往返 |
| 云 LLM/STT 现场网络抖动 | 规则解析优先（agent.py 已具）；演示兜底脚本回放叙事 |
| 戒指模式互斥/电量 | 只用双击(不翻模式) + 时间窗睡眠启发式 + 电量守卫 |
| 前端 WS 与游戏节奏不同步 | 前端只读渲染 + tick 推送；断连显示 safe-idle 态 |

**明确的新增待建文件**：`stt.py`（语音转写 worker）、`scheduler.py`（日程调度）、前端 `dashboard/hud.html`（+ Python WS 推送端）。其余均在既有模块上扩展。
