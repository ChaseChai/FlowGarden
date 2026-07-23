# 分身农庄 Avatar Farm · 项目总览与进度

> 工作代号 **Stardew Ring Bridge** · AdventureX 2026
> 本文是项目的**整体现状文档**：一处看清「做了什么 / 还差什么 / 接下来怎么做」。
> 需求真源见 [PRD.md](./PRD.md)，集成/选型/环境见 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。
> 本文与它们不重复，只做**当前实现快照 + 待办地图 + 被保留的日程调度设计**。

---

## 0. 一句话与核心闭环

戴上戒指开始专注，你的农场分身就在《星露谷物语》替你种地；分心摸鱼、不按计划做事，分身就会跟着耽误农活、作物枯萎——**把自律变成一场看得见的耕作**。

```
戒指(双击/语音)
  → 现实状态 (focus / rest / distracted / sleep)
  → 日程调度 (计划 vs 实际，流动重排 + 主动干预)   ← 本次重点保留
  → 行为策略 (efficiency + 语义动作)
  → player_* 动作 (直接驾驶 Game1.player)
  → 游戏结果 (金币/体力/作物)
  → 反馈 (TTS / HUD 正负反馈)
  → 回到现实提醒
```

---

## 1. 架构现状（重要：已从「影子农夫」转向「直接驾驶主玩家」）

PRD §4 仍按 fork 上游的 **shadow Farmer + companion NPC** 描述。**实际实现已转向更简洁的方案**：

| 维度 | 上游方案（PRD 原文） | 本项目现状（已落地） |
| --- | --- | --- |
| 谁在种地 | 隐形 shadow Farmer + 可见 companion NPC | **直接驾驶 `Game1.player` 主玩家** |
| 动作集 | `stardew_*` 全局 + player 模式 25 工具 | **`player_*` 动作**（move_to/farm/use_tool/warp/face/interact/attack/stop/idle/chat）|
| 贴图/NPC 配对 | 需要 64x128 sprite + NPC 同步 | **无需**（主玩家自带贴图） |
| 通信 | MCP Server ↔ SMAPI 走 JSON 文件 | 不变：`bridge_data.json` + `actions/` 队列（原子写 tmp→rename，读后即删） |
| 已知代价 | 联机 NPE、影子同步 | 真玩家钓鱼会弹 `BobberBar` 小游戏（需 MOD 内每帧处理） |

> 待办：把 PRD §4 / §13 的 shadow farmer 表述同步更新为「直接驾驶主玩家」，避免文档与实现漂移。

### 分层数据流（现状）
```
戒指 (ring_sound.py, BLE/NUS)
  │ 双击 0x0703 → double_tap ; 长按录音 → voice_recorded(WAV)
  ▼
ring_bridge.py ── 归一化事件 ─▶ event_bus.py
  ▼
state_engine.py  现实状态机: focus/rest/distracted/sleep + efficiency∈[0,1]
  ▼
scheduler.py(拟新增) 日程: 计划 vs 实际, 流动重排 + 主动干预      ← §6 重点
  ▼
mapping.py  语义策略: FARM/WANDER/IDLE/SLEEP + 效率节奏缩放 + negative
  ▼
orchestrator.py  GamePilot: 语义动作 → player_* 动作文件
  ▼ actions/*.json
[Node] MCP Server ─▶ [C#] SMAPI MOD (ModEntry + PlayerPilot.cs) ─▶ 《星露谷》1.6
  ▲ bridge_data.json (agentPlayer: mode/tile/moving/stamina/...)
  │
feedback.py  回读金币/体力增量 → TTS/HUD 正负反馈
```

---

## 2. 完成度矩阵

| 层 / 模块 | 文件 | 职责 | 状态 |
| --- | --- | --- | --- |
| 需求文档 | PRD.md / IMPLEMENTATION_PLAN.md / docs/tool_inventory.md | 需求·选型·工具面 | ✅ 完成（PRD 架构表述待更新） |
| P0 基座 | vendor/（fork clone + Node MCP build） | 编译链、桥接通信 | ✅ 编译通过 |
| 游戏 MOD | vendor/smapi-mod/ModEntry.cs | 动作分发（`player_*` 前缀路由） | ✅ 重写完成 |
| 游戏 MOD | vendor/smapi-mod/PlayerPilot.cs | 驾驶主玩家：移动/寻路/用工具/农场自主 | ✅ 编译通过，⚠️ **未部署实测** |
| 戒指桥接 | python/ring_bridge.py | BLE → 双击/录音事件（带 demo_mode 兜底） | ✅ 逻辑完成，⚠️ 未接真机 |
| 状态引擎 | python/state_engine.py | 四态机 + efficiency | ✅ 完成 |
| 映射层 | python/mapping.py | 语义策略 + 效率节奏 + negative | ✅ 完成（离线验证过） |
| 编排 | python/orchestrator.py | GamePilot：语义→player_*，状态/语音循环 | ✅ 完成（DEMO 干跑验证） |
| Agent 接口 | python/agent.py | 自然语言→player_* 规则解析 + LLM 兜底 + CLI | ✅ 完成（15 用例验证） |
| 反馈 | python/feedback.py | 金币/体力监控 + PowerShell TTS | ✅ 基本完成，⚠️ 遗留 companions 字段待清 |
| 入口 | python/main.py | 各模块编排启动 | ✅ 完成 |
| 事件/配置 | python/event_bus.py / config.py | 事件总线、路径与密钥 | ✅ 完成 |
| **日程调度** | **python/scheduler.py（拟新增）** | **计划管理 + 流动重排 + 主动干预 + 拖延惩罚** | ⬜ **未实现（本次保留设计，见 §6）** |
| 精确操控 | PlayerPilot.cs 扩展 | player_mine / player_fish / checkForExhaustion / 酿酒 / 喂养 | ⬜ 未实现（上游算法待移植） |
| 语音链路 | STT 接入 | voice_recorded(WAV) → 文本 → voice_cmd | ⬜ 缺 STT 环节 |
| 稳定性 | watchdog / 限速护栏 / 演示兜底 / HUD | 现场抗抖动 | ⬜ 未实现 |

---

## 3. 已完成部分（细节）

### 3.1 P0 基座与游戏 MOD
- fork `amarisaster/StardewValley-MCP` clone 到 `vendor/`，Node MCP server `npm run build` 通过。
- 删除 companion 相关 5 个文件，重写 `ModEntry.cs`：以 `actionType.StartsWith("player_")` 路由到 `PlayerPilot`。
- `PlayerPilot.cs`（约 426 行）实现：`Tick()` 每帧驱动 `PathFindController` + 到达检测(dist≤1.5) + 卡住(120tick)重定位；`HandleCommand` 分发 `player_move_to / player_farm / player_use_tool / player_warp / player_face / player_interact / player_attack / player_stop / player_idle`；`GetStatus()` 回写 `bridge_data.json` 的 `agentPlayer`（mode∈{idle,manual,farm}）。
- **编译产物在 `bin/Release/net6.0/`，尚未部署到 Mods**（游戏运行时 DLL 被锁）。

### 3.2 Python 全链路
- **state_engine.py**：focus/rest/distracted/sleep 四态 + efficiency，发布 `focus_start/rest/distracted/sleep/voice_cmd/tick` 事件。
- **mapping.py**：语义动作 `FARM/WANDER/IDLE/SLEEP` + `BehaviorStrategy`（mode/moves/action_interval_sec/negative）；`get_strategy(mode, efficiency, distraction_count)`——distracted 且累计≥3 触发 `negative` 策略；用 `copy.copy` 避免污染共享模板；productive 时按 efficiency 缩放下发节奏。
- **orchestrator.py**：`GamePilot` 把语义动作翻译为 `player_*` 文件（farm 仅在 `mode!="farm"` 才重发，避免打断进行中的动作；wander 读 tile±4 随机移动；sleep = warp FarmHouse + stop；voice 走 `IntentParser`）。状态/语音双循环 + 动作节奏循环。
- **agent.py**（约 348 行）：`ActionBridge`（原子写 actions）+ `IntentParser`（规则优先、LLM 兜底）+ `StardewAgent` 门面 + CLI REPL；关键词映射覆盖浇水/收割/移动/工具/采矿/钓鱼/传送等。
- **ring_bridge.py / feedback.py / main.py / event_bus.py / config.py**：戒指监听（含 `demo_mode` 兜底）、金币体力监控 + TTS、启动编排、事件总线与配置齐备。

### 3.3 离线验证
- Agent 解析器：15 条自然语言用例 → `player_*` 映射全部正确。
- 编排 DEMO 干跑：全状态策略 + GamePilot 各动作产出 8 个 `player_*` 动作文件，逐一核对正确。

---

## 4. 待部署 / 阻塞项

- **新 PlayerPilot DLL 未部署**：两次部署均因游戏运行锁定 `Mods\StardewMCPBridge\StardewMCPBridge.dll`（`System.IO.IOException`）。**编译本身成功**。→ 需彻底关闭游戏到桌面后 `dotnet build -c Release`，再进世界实测 `player_farm / player_move_to / player_use_tool`，回读 `bridge_data.json.agentPlayer` 验证。
- **在部署前，所有 `player_*` 动作在游戏内均不生效**（旧 companion 逻辑已删）。

---

## 5. 待完成部分（Roadmap）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| P0 | 部署新 DLL + 游戏内实测 | 关游戏 → 编译 → 进世界实测三基础动作 |
| P1 | **日程调度模块 scheduler.py** | 本次要保留的设计（§6），闭环叙事核心 |
| P1 | player_mine / player_fish + checkForExhaustion | 移植上游算法；钓鱼需处理 `BobberBar` 小游戏；用工具后补体力结算 |
| P2 | 酿酒 / 喂养动物 chore | 扩展 chore 词表（见 §6.5）：kegs 装填、喂动物 |
| P2 | STT 接入 | `voice_recorded`(WAV) → 云 STT → 文本 → `voice_cmd`（当前缺这一环） |
| P2 | feedback 精化 | 去除遗留 `companions` 字段，改读 `agentPlayer`；正反馈结算文案 |
| P3 | 戒指真机联调 | 双击/录音/断线自愈实测 |
| P3 | watchdog / 限速护栏 / 演示兜底脚本 / HUD | 现场抗抖动，演示生命线 |

---

## 6. 【保留设计】日程规划流动重排序 + 主动式干预

> 这是从旧「镜园」项目（`archive/docs/镜园_前端画风设计指南.md` §11 专注模式工作台）延续保留的核心设计，**必须在分身农庄中承接**。
> 核心升级：把「现实日程」与「游戏农活」**双向绑定**——**没专注、没按计划完成事务时，游戏角色同样会耽误种地/浇水/收菜/挖矿/酿酒/喂养。**

### 6.1 设计溯源（镜园 §11）
原设计包含四块：**AI 晨间规划**（生成今日待办/日程）、**待办清单**、**日程时间线**、**AI 流式编排对话**。其中两个能力是本次要保留的骨架：
- **流动重排序**：当某项拖延/超时/被分心打断，AI 自动把后续日程项顺延重排，并给出建议（原文示例："把回邮件挪到午休后吧"、"把数学复习提前到 16:00"）。
- **主动式干预**：AI 不只被动响应，会主动提醒/催促/建议休息（原文示例："你已经分心 3 次了，休息 5 分钟吧"）。

### 6.2 数据模型（scheduler.py）
```
ScheduledTask:
  id            任务标识
  title         "写论文" / "复习数学"
  planned_start 计划开始 (HH:MM)
  duration_min  预计时长 (min)
  category      现实类别 → 决定映射的游戏农活 (见 6.5)
  status        pending / in_progress / done / slipped(拖延) / dropped
  game_chore    绑定的游戏农活 (watering / harvest / planting / mining / brewing / feeding)

Plan:
  tasks[]       今日任务列表 (AI 晨间生成 / 语音添加 / 手动)
  now_index     当前应执行项
  progress()    on_schedule / behind / overdue 判定
```

### 6.3 流动重排序算法
每个 tick + 状态变更时评估：
1. **判定进度**：`now > task.planned_start + duration` 且未完成 → 标 `slipped`。
2. **顺延重排**：`slipped` 项之后的 `pending` 项整体后移；若与固定时间窗（如运动 19:00）冲突，压缩弹性项或提示丢弃。
3. **产出建议**：生成一条自然语言建议（"把 X 挪到 Y 之后"），经 `event_bus` → `feedback` 推送，等待用户 [采用]/[忽略]。
4. **重排即改绑**：重排后的 `game_chore` 顺序同步影响 orchestrator 的农活下发顺序。

### 6.4 主动式干预策略
| 触发条件 | 干预动作（现实侧） | 联动游戏侧 |
| --- | --- | --- |
| 到点未开始某任务 | TTS/HUD 提醒"该做 X 了" | 分身停在对应农活前"待命"（未开工） |
| 分心累计达阈值 | "已分心 N 次，休息 5 分钟吧" | 分身效率下降 / 闲逛（negative 策略） |
| 任务超时未完成 | 建议重排 / 缩短 | 对应农活被跳过或推迟（见 6.6） |
| 长期怠惰 | 强提醒"回来专注" | 作物枯萎、体力耗尽、金币停滞 |

> 干预走 `event_bus` 事件 + `feedback` 通道；不新增戒指原语（戒指仍只输出双击+语音，符合 PRD §5 硬约束）。

### 6.5 现实日程类别 → 游戏农活映射
每个现实任务类别绑定一段游戏农活，专注按计划完成 → 分身高效执行；否则耽误。

| 现实类别（示例） | 游戏农活 game_chore | 对应 player_* 实现 | 现状 |
| --- | --- | --- | --- |
| 学习/写作/深度工作 | 浇水 watering + 收菜 harvest + 种地 planting | `player_farm`（自主 DoFarm 覆盖三者） | ✅ 已实现（待部署实测） |
| 高强度攻坚/运动 | 挖矿 mining | `player_warp`(Mine) + `player_mine`(待实现) | ⬜ 待实现 |
| 碎片/放松任务 | 钓鱼 fishing | `player_fish`(待实现，处理 BobberBar) | ⬜ 待实现 |
| 例行事务/维护 | 酿酒 brewing（装填 kegs） | 新增 chore（interact 机器） | ⬜ 待实现 |
| 例行事务/维护 | 喂养动物 feeding | 新增 chore（进畜棚放草料） | ⬜ 待实现 |

### 6.6 拖延 → 分身耽误（负面后果映射）
**这是本次强调的闭环**：现实没专注 + 没按计划完成 → 游戏分身**同样耽误**，产生可见后果。

| 现实情况 | 分身表现 | 可见游戏后果 |
| --- | --- | --- |
| 到点没专注（任务未开工） | 分身不去做该农活，原地闲逛 | 作物没浇水 → 缺水；机器没装填 → 无产出 |
| 专注中途分心 | 效率下降、动作变慢 | 少浇几块地、少收几株、酿酒延迟 |
| 任务超时/丢弃 | 该农活被跳过 | 动物没喂 → 好感/产奶下降；矿没挖 → 无矿石收益 |
| 长期怠惰 | 分身停摆 | 作物枯萎、体力耗尽、金币停滞（negative 策略） |

映射实现要点：
- scheduler 每次判定出 `slipped/overdue` → 通过 `mapping.get_strategy` 叠加惩罚（降低 productive 比例、拉长 `action_interval_sec`、达阈值切 `negative`）。
- orchestrator 的农活下发顺序跟随重排后的 `game_chore` 队列；被跳过的 chore 不下发对应 `player_*`，游戏侧自然产生"没做"的后果（如未浇水的作物进入缺水状态）。

### 6.7 落地状态
- **未实现**：`scheduler.py` 为拟新增模块。现有 `state_engine`（四态）+ `mapping`（efficiency/negative）+ `orchestrator`（GamePilot）已具备承接它的接口面：scheduler 只需在状态之上叠加「计划 vs 实际」维度，并把重排结果喂给 mapping/orchestrator。
- **接入点**：订阅 `tick / focus_start / distracted / voice_cmd`；产出「重排建议事件」给 feedback、「chore 队列 + 惩罚系数」给 orchestrator/mapping。

---

## 7. 里程碑对照（P0–P5 现状）

| 阶段 | 目标 | 现状 |
| --- | --- | --- |
| P0 基座 | clone/编译/桥接/工具面 | ✅ 完成（MOD 待部署实测） |
| P1 戒指桥接 | 双击 + 录音 + 断线守卫 | 🟡 逻辑完成，未接真机；STT 未接 |
| P2 状态+映射 | 四态 + 映射策略 | ✅ 完成（+ 语义动作/效率/negative） |
| P3 编排+Agent | LLM + MCP 客户端双循环 | ✅ 完成（agent.py + orchestrator） |
| P4 反馈 | 回读 + TTS/HUD | 🟡 基本完成，字段待精化 |
| P5 稳定+演示 | watchdog/兜底/HUD | ⬜ 未开始 |
| **P1.5 日程调度** | **流动重排 + 主动干预 + 拖延惩罚** | ⬜ **本次保留设计，待实现（§6）** |

---

## 8. 下一步建议顺序
1. **关游戏 → 部署新 DLL → 进世界实测** `player_farm / player_move_to / player_use_tool`（打通"能动"基线）。
2. 移植上游 **player_mine / player_fish + checkForExhaustion**，补齐挖矿/钓鱼农活。
3. 实现 **scheduler.py**（§6）：先做「计划 vs 实际 → 惩罚系数」最小闭环，再加流动重排与主动干预建议。
4. 扩展 **酿酒 / 喂养** chore，补全 §6.5 映射表。
5. 接 **STT**，打通语音精确指令。
6. **稳定性收尾**：watchdog / 限速护栏 / 演示兜底脚本 / HUD。
