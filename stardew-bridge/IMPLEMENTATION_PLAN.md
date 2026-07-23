# 开发实施计划：分身农庄 Avatar Farm

> 配套文档 · 与 [PRD.md](./PRD.md)、[DEV_PLAN.md](./DEV_PLAN.md)（团队分工）并列
> 本文聚焦 5 件事：**开发步骤 / 成熟方案集成评估 / Agent 选型 / 环境配置 / 优先级**。
> 步骤与团队分工的详细任务卡见 DEV_PLAN.md，本文不重复，只补充「集成、选型、环境」这三块新决策。

---

## 决策速览（TL;DR）

| 问题 | 结论 |
| --- | --- |
| 是否 fork StardewValley-MCP | **是，立即 fork 集成**。它已实现最硬的 shadow farmer + 25 工具 + 自主模式，自研至少省下数天且规避高风险。 |
| Agent 用 Hermes 还是新建 | **都不**。沿用云端 Claude/GPT 作 Agent LLM（与 PRD §4.3 一致）；不自托管 Hermes（普通服务器无 GPU 扛不动实时推理），不从零造 Agent 框架（MCP + LLM 工具调用已足够）。Hermes 列为「日后有 GPU 再启用」的离线兜底。 |
| 云服务器角色 | 仅作 **API 调用代理/密钥托管**（可选）。游戏 + MOD + MCP + 戒指桥接全部跑在**本地演示机**。 |
| 最短可演示路径 | 双击 → focus → 触发自主 farm 模式 + `water_all`/`harvest_all` → 读金币增量 → TTS 正反馈。**绕开逐帧 LLM 控制与语音**，最快出原型。 |

---

## 1. 开发步骤分解（从当前状态到可演示）

当前状态：工作区已整理，`ring_sound.py` 已就位 `python/`，PRD/分工/本计划三份文档齐备，**尚未开始编码**。

里程碑 P0–P5 的完整任务卡（负责人/技术要点/交付物/验收）见 **DEV_PLAN.md §2**。这里只给出结合真实仓库信息后**需要强调或修正的技术要点**：

### P0 基座打通（关键路径，最先做）——补充要点
- fork 后**先跑通仓库自带能力**再动业务：`git clone` → 按 README 编译 `smapi-mod`（需设 `GAME_PATH`）→ `cd mcp-server && npm install && npm run build`。
- **验证顺序**：启动游戏(SMAPI) → 载入存档 → `stardew_spawn` → 试 `stardew_farm`(自主) → 试 player 模式 + `stardew_move_to`/`stardew_use_tool`。
- **实测枚举工具面**：把 25 个工具逐一冒烟，记录成功率与限制到 `docs/tool_inventory.md`。重点确认 1.6 兼容性与寻路可靠性。
- **需准备**：companion sprite 资源（64x128，4x4 网格）——美术小成本，可先用占位图。
- **关键认知**：MCP↔SMAPI 是 **JSON 文件轮询**（非实时），且仓库自己加了 auto-combat 因为「LLM 往返太慢」→ **高频动作（战斗/连续采集）走自主模式或一键工具，绝不用 LLM 逐帧驱动**。

### P1–P5——沿用 DEV_PLAN，叠加以下调整
- **P2 映射层**要直接对齐真实工具面：把「专注高效」映射到**自主 `farm` 模式 + `water_all`/`harvest_all`**（省 LLM 往返、稳），把「语音精确指令」映射到 **player 模式的直接控制工具**。
- **P3 编排**：orchestrator 本质是**一个 MCP 客户端 + 状态循环**，不是重造 Agent 平台（详见 §3）。
- **P4 反馈**：`stardew_get_state` 已直接返回 time/weather/player stats/companion status → 金币/体力增量做差值即可。

---

## 2. 现有成熟方案集成评估（StardewValley-MCP）

**结论：立即 fork 集成，不自研游戏控制层。** 我们的原创价值在「现实↔游戏映射 + 反馈闭环」，不在重造游戏操控。

### 2.1 仓库实况（已实测拉取，v0.3.0）
- **架构**：AI Agent ↔(stdio)↔ MCP Server(Node.js) ↔(JSON 文件)↔ SMAPI Mod(C#) ↔ 游戏。
- **shadow farmer**：继承 Farmer 类、不可见（draw no-op），经原生 API 执行工具/战斗/钓鱼；配对可见 companion NPC 提供贴图。
- **25 工具**：13 全局（含 `get_state`/`spawn`/`farm`/`mine`/`fish`/`water_all`/`harvest_all`/`warp`/`chat`）+ 12 player 模式（`get_surroundings`/`move_to`/`use_tool`/`interact`/`attack`/`cast_fishing_rod`/`eat_item` 等）。
- **两类模式**：自主（follow/farm/mine/fish/idle）+ player（LLM 直接控制）。
- **许可证 MIT**；官方示例就用 Claude Code 作 MCP client。

### 2.2 优势
- 省下**最硬的 C# shadow farmer**（多人网络同步 NPE 等坑它已踩平：故意不入 `Game1.otherFarmers`）。
- **一键工具 + 自主模式**直接支撑我们的效率映射，大幅降低对 LLM 实时性的依赖。
- v0.3.0 已修大量稳定性问题（原子写、竞态、寻路卡住检测、钓鱼超时、逐 companion 崩溃隔离）。
- MIT 可自由改造；与我们云端 Claude 路线**天然契合**。

### 2.3 风险与代价
| 项 | 说明 | 对策 |
| --- | --- | --- |
| 环境门槛 | 需 Stardew 1.6+ / SMAPI 4.0+ / Node 18+ / .NET 编译 | P0 优先搭好本地环境 |
| JSON 文件轮询非实时 | 高频动作 LLM 往返慢 | 高频走自主模式/一键工具，LLM 只做策略级决策 |
| 需 sprite 资源 | companion 需 64x128 贴图 | 占位图先行，美术后补 |
| 单机向 | shadow farmer 不支持多人 | 对本项目（单人演示）无影响 |

### 2.4 我们改什么 / 不改什么
- **不改**：smapi-mod 核心、mcp-server 工具实现（尽量原样复用）。
- **改/加**：MCP 客户端侧的 orchestrator（映射→工具调用）、状态引擎、戒指桥接、反馈——**全在 Python 侧**，不动它的 C#/Node 核心。集成点 = MCP 客户端连它的 MCP server。

---

## 3. Agent 技术选型

### 3.1 结论
**沿用云端 Claude/GPT 作 Agent 的 LLM（与 PRD §4.3 一致）；不自托管 Hermes；不从零造 Agent 框架。**

### 3.2 三方案对比（性能 / 稳定性 / 开发成本）
| 方案 | 性能 | 稳定性 | 开发成本 | 结论 |
| --- | --- | --- | --- | --- |
| **云端 Claude/GPT + MCP 工具调用** | 函数调用最强最稳 | 云端成熟，极稳 | 低（官方即 Claude MCP，直接接） | ✅ **采用** |
| **自托管 Hermes（开源）** | 受限于本地算力；普通服务器**无 GPU 无法实时推理** | 需自己保证函数调用格式稳定 | 高（部署/量化/运维） | ❌ 暂不；列为日后有 GPU 的离线兜底 |
| **从零开发新 Agent 系统** | 取决于自研质量 | 未经验证，风险高 | 很高（黑客松不划算） | ❌ 不做 |

### 3.3 「是否要开发新 Agent 系统」的澄清
不需要。所谓 Agent 在本项目里就是：**一个 MCP 客户端 + 状态/语音驱动的 LLM 工具调用循环**（`orchestrator.py`）。Claude/GPT 原生支持 tool use，仓库官方也用 Claude Code 作 MCP client——我们只是把「触发源」从人类聊天换成「戒指状态 + 语音」，并加护栏（白名单/限速/超时重试）。这不是造平台，是写一段编排脚本。

### 3.4 Hermes 的定位
你们的自托管 Hermes 保留为**可选离线兜底**：若日后拿到 GPU 机器，可在常规状态循环里用 Hermes 省 API 成本、复杂规划再切云端。**MVP 不含**，避免普通服务器上强推自托管拖慢进度。

---

## 4. 环境配置（利用现有资源）

### 4.1 关键认知：什么必须在本地
游戏、SMAPI MOD、Node MCP server、戒指 BLE 桥接**必须都在同一台本地演示机**，因为：
- 游戏与 MOD 在本地运行；
- MCP↔SMAPI 走**本地 JSON 文件**，MCP server 必须能读写游戏 Mods 目录；
- 戒指 BLE 需**物理接近**演示机。

→ 云服务器**不承担**游戏/推理，普通服务器无 GPU 也不自托管模型。

### 4.2 各资源的角色分配
| 资源 | 角色 | 说明 |
| --- | --- | --- |
| **本地演示机** | 全链路主机 | 游戏 + SMAPI MOD + Node MCP server + Python(桥接/状态/编排/反馈) + 戒指 BLE |
| **普通云服务器** | 可选 API 代理 | 托管 API Key、统一出口/限流；不接则本地直连云 API 亦可 |
| **大模型 API** | Agent 推理 | Claude/GPT（工具调用）+ Whisper（STT） |
| **自托管 Hermes** | 暂不启用 | 需 GPU；列为日后离线兜底 |

### 4.3 本地环境清单（P0 前置）
- 正版《星露谷物语》1.6+、SMAPI 4.0+、.NET 6 SDK、Node.js 18+、Python 3.11、ffmpeg（WAV 转码）、`bleak`（BLE）。
- 云 LLM Key + Whisper Key（放**环境变量**，`.env` 入 `.gitignore`，不进库）。
- 戒指 MAC 地址（`ring_sound.py` 按 MAC 连接）。
- companion sprite/portrait 占位图。

### 4.4 分层测试环境（从脱机到全链路）
1. **纯逻辑（脱机）**：state_engine / mapping 用 mock 事件序列跑单测，不接游戏不接戒指。
2. **游戏中间层（本地）**：接 fork 的 MCP server + 游戏，手动调工具验证。
3. **戒指真机**：接戒指验证双击/录音/断线自愈。
4. **全链路彩排**：四层齐跑 + 故障注入（断网/断戒指/游戏卡顿）。

---

## 5. 优先级排序（快速搭原型）

分级细则见 DEV_PLAN §3（MoSCoW）。这里给出**最短可演示路径**——尽快让评委看到「现实→游戏」闭环：

### 5.1 最短可演示路径（MVP 关键链）
```
戒指双击(0x0703) → focus_start
   → orchestrator 触发 stardew_farm(自主农场模式)
   → 周期调 stardew_water_all / stardew_harvest_all
   → stardew_get_state 读金币/体力增量
   → 桌面 TTS 正反馈「专注 N 分钟，农场丰收 XXXg」
```
这条链**刻意绕开**逐帧 LLM 控制与语音识别（最长、最易抖的两段），是最快、最稳的可演示原型。

### 5.2 增量叠加顺序
1. **先做**上面的最短链（Must）。
2. 加**负反馈/枯萎**（分心久 → 提醒）——强化叙事。
3. 加**语音指令**（player 模式精确控制）——亮点，但依赖 STT+LLM，链长后置。
4. 加 **watchdog + 演示兜底脚本**——与最短链**并行搭建**，别等最后。
5. 可选：健康面板、HUD。

### 5.3 演示稳定性红线
无论进度如何，**演示兜底脚本（无戒指/无游戏也能回放 focus→distracted→sleep 叙事）必须最先具备**，它是现场抗抖动的生命线（PRD §8 / DEV_PLAN §4）。

---

## 6. 与其他文档的关系
- **PRD.md**：需求与架构的唯一真源（本次已修正许可证为 MIT、补全工具面与 JSON 文件通信）。
- **DEV_PLAN.md**：团队分工 + P0–P5 任务卡 + MoSCoW + 甘特。
- **本文**：集成评估 + Agent 选型 + 环境配置 + 最短原型路径。三份互补，不重复。
