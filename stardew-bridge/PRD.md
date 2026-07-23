# 项目 PRD：分身农庄 Avatar Farm（工作代号 Stardew Ring Bridge）

> 版本 v1.0 · AdventureX 2026 · 本文件为项目转型后的主需求文档
> 名称「分身农庄」为提案，可调整；下文统一以「本系统」指代。

---

## 1. 项目概述

### 1.1 转型背景
经评估后决定转型——**不再自建花园世界，而是把现实专注状态映射进《星露谷物语》**，让 AI Agent 作为用户的「数字分身」在成熟的游戏世界里替用户耕作，形成"现实驱动游戏、游戏反哺现实"的闭环。

### 1.2 一句话定位
戴上戒指开始专注，你的农场分身就在星露谷替你种地；分心摸鱼，作物就会枯萎——**把自律变成一场看得见的耕作**。

### 1.3 原创性声明（答辩用）
星露谷只是「底座世界」。本系统的原创贡献在于三层，均与游戏本体无关：
1. **现实↔游戏映射算法**：将生理/行为状态量化为游戏行为策略与效率。
2. **戒指具身交互**：以最小原语（开始/结束专注 + 语音）驱动一个自主 Agent。
3. **双向反馈闭环**：游戏结果实时回哺现实提醒，形成自律正反馈。

---

## 2. 目标与非目标

### 2.1 目标
- 打通「戒指 → 现实状态 → LLM Agent → 星露谷操作 → 结果反馈」完整链路。
- 现实专注度可量化影响游戏产出效率（专注越久越深，收益越好）。
- 分心/长期怠惰在游戏中产生可见负面后果。
- 面向**黑客松答辩 demo** 稳定可演示。

### 2.2 非目标（明确不做）
- 不做面向大众的可交付产品（星露谷为付费专有游戏，用户无法人手一份 + 装 MOD）。
- 不追求游戏 AI 的通用性/全自动通关。
- 不做视觉识别控制（放弃截屏识别方案，误差与误触风险高）。
- 现阶段不引入 IMU 睡眠精确检测（列为可选增强，见 §6.1）。

---

## 3. 用户与场景

- **主用户**：需要自律的学习/工作者（答辩中的演示者）。
- **核心场景**：
  1. 用户双击戒指「开始专注」→ 农场分身开始高效种地/浇水/收割。
  2. 专注中语音下指令「去钓鱼」→ 分身切换到钓鱼。
  3. 用户分心离开 → 分身效率下降、闲逛。
  4. 长期怠惰 → 作物枯萎、体力耗尽，桌面提醒"回来专注"。
  5. 用户「结束专注」→ 结算本次收益，正反馈激励。

---

## 4. 系统架构

### 4.1 分层数据流
```
戒指 (BLE/NUS)
  │  按键双击 / 长按录音
  ▼
[Python] Ring Bridge  ring_bridge.py
  │  归一化事件 JSON（focus_start/focus_end/voice_cmd/sleep）
  │  录音 → WAV → 云 STT → 指令文本
  ▼ (本地 WebSocket)
[Python] State Engine  state_engine.py
  │  现实状态：focus / rest / distracted / sleep + 强度
  ▼
[Python] Orchestrator + Agent  orchestrator.py
  │  云 LLM（Claude/GPT）+ MCP 客户端；状态循环 + 语音循环
  ▼ (MCP 协议)
[Node.js] MCP Server（fork 自带，约 25 工具）
  ▼
[C#] SMAPI MOD（fork 自带）：companion NPC + 不可见 shadow Farmer
  ▼  游戏原生 API 执行 & 状态回读
《星露谷物语》1.6
  │  体力/金币/作物/时间/背包
  ▼
[Python] Feedback  feedback.py → 桌面 TTS / HUD 提醒
```

### 4.2 语言与职责划分
| 层 | 语言 | 来源 | 改动量 |
| --- | --- | --- | --- |
| 游戏 MOD（shadow farmer） | C#/.NET 6 | Fork，尽量不改 | 小 |
| MCP 工具服务 | Node.js | Fork，尽量不改 | 小 |
| 戒指桥接 + 状态 + 编排 + 反馈 | Python 3.11 | **本项目自研** | 主 |
| 状态/反馈 HUD（可选） | 复用 garden-web 前端 | archive 改造 | 可选 |

### 4.3 已锁定技术决策
- **实现基座 = Fork `amarisaster/StardewValley-MCP`（MIT 许可，v0.3.0）**：复用其 shadow Farmer（继承 Farmer 类、原生 API 执行工具/钓鱼/战斗）与 25 个 MCP 工具（13 全局 + 12 player 模式）+ 自主模式（farm/mine/fish），只改映射/反馈逻辑。MCP Server↔SMAPI 经本地 JSON 文件（bridge_data.json + actions 队列）通信。
- **LLM = 云端 Claude/GPT**：工具调用与推理最稳，配合演示兜底应对网络抖动。
- **ASR = 云 STT（Whisper API）**：与云 LLM 一致；SDK 只产出 WAV，转文字需外接。

---

## 5. 戒指能力边界（硬约束，设计前提）

基于 Ring Sound SDK（BLE/NUS，Python 单文件，v4 协议）实测能力：
- **录音模式与手势/IMU 模式互斥**，且**无法用程序查询/切换模式**（仅物理按键切换，且为"尽力而为"不保证成功）。
- **按键双击 `0x0703`**：排他事件、**不翻转设备模式** → 作为「开始/结束专注」的干净离散开关。
- **单击 `0x0704`**：会尝试翻转录音/手势模式 → **不用于状态切换**，避免副作用。
- **长按录音**（默认录音模式）→ `receive_auto_audio_file()` 取 WAV → STT → 语音指令。
- 电量 <20% 拒绝录音/手势；同一 BLE 连接**不可并发消费**数据队列；断线需自动重连。

> 结论：戒指定位为「哑终端」，只输出最小原语（专注开关 + 语音），复杂决策全在上位机 Agent。

---

## 6. 功能需求

### 6.1 戒指交互（ring_bridge.py）
- **FR-1 专注开关**：监听双击 `0x0703`，切换 focus_start / focus_end 事件。
- **FR-2 语音指令**：监听长按录音自动上报 → 解码 WAV → 云 STT → 文本 → voice_cmd 事件。
- **FR-3 睡眠推断**：时间窗（如夜间）+ 长时间无事件静默 → sleep 事件。（IMU 体动检测为可选增强，因与录音模式互斥，暂不纳入 MVP）
- **FR-4 健壮性**：BLE 断线退避重连；电量守卫；事件经本地 WebSocket 推送。

### 6.2 状态引擎（state_engine.py）
- **FR-5 状态机**：产出 focus / rest / distracted / sleep 四态。
  - focus：专注计时中；强度 = f(本次时长, 连续天数 streak)。
  - distracted：专注中途异常结束 / 超时无操作。
  - rest：主动结束专注。
  - sleep：见 FR-3。
- **FR-6 强度输出**：efficiency ∈ [0,1]，供映射层决定游戏行为节奏。

### 6.3 现实→游戏映射表（mapping.py）
| 现实状态 | 触发 | 游戏行为策略（productive→passive） | 效率 |
| --- | --- | --- | --- |
| 专注 focus | 双击开始，计时中 | 浇水→收割→播种→采矿→钓鱼→酿酒，高频高价值 | 随专注时长/streak 提升 |
| 分心 distracted | 中途异常结束 / 长时间无操作 | 闲逛、低价值重复动作，不推进生产 | 低 |
| 休息 rest | 主动结束专注 | 进商店/散步等被动活动，维持不衰退 | — |
| 睡眠 sleep | 时间窗 + 静默 | 回家睡觉，仅一次性基础维护（喂动物），世界过夜 | 维护级 |
| 长期分心 | distracted 累计超阈值 | 负面：作物缺水枯萎、体力耗尽、矿洞未清、金币停滞 | 负 |

### 6.4 编排 + Agent（orchestrator.py）
- **FR-7 状态驱动循环**：状态变更 → 按映射生成行为策略提示 → LLM 规划 → 下发 MCP 工具调用。
- **FR-8 语音指令循环**：STT 文本 → LLM 解析意图 → MCP 工具调用。
- **FR-9 Agent 护栏**：工具白名单；每分钟动作上限（限速）；破坏性操作（卖高价物/送礼贵重）默认禁止，仅语音显式授权；单次工具调用超时 + 重试。

### 6.5 反馈闭环（feedback.py）
- **FR-10 状态回读**：每 tick 经 MCP 读体力/金币增量/作物健康/游戏时间/背包。
- **FR-11 正反馈**：专注高→收益好→桌面 TTS/HUD："专注 45 分钟，农场丰收 320g。"
- **FR-12 负反馈**：分心过久→枯萎→提醒："作物开始枯萎了，回来专注吧。"
- 反馈主走桌面 TTS + HUD（戒指 LED 能力有限）。

---

## 7. 状态同步机制
- **Push 模型**：Ring Bridge →(本地 WebSocket)→ Orchestrator 持有 current_state。
- 驱动方式：状态变更事件触发 + 定时 tick（如每 15s）兜底。
- 现实专注度 → 游戏效率的体现：**工具调用节奏 + productive/idle 动作比例**随 efficiency 缩放。

---

## 8. 稳定性与演示保障
- **Watchdog**：监控 ring / bridge / MCP / game 四层健康；任一断开进入 safe-idle（暂停下发、保持最后状态）。
- **限速 + 重试 + 超时**：游戏无响应则空转不报错。
- **演示兜底**：脚本化状态序列（不接戒指也能回放 focus→distracted→sleep），规避现场 BLE/网络/LLM 抖动。
- **健康面板**：可视化四层连接状态 + 现实/游戏对照。
- **全链路日志**：便于复盘。

---

## 9. 里程碑（P0–P5）

| 阶段 | 目标 | 关键交付 |
| --- | --- | --- |
| **P0 基座打通** | clone fork，编译 SMAPI MOD，跑通 Node MCP，验证 shadow farmer 生成/移动/用工具，**实测枚举真实工具面** | 可用游戏中间层 + 工具清单 |
| **P1 戒指桥接** | 双击专注开关 + 语音→WAV→STT；断线/电量守卫；WS 推事件 | ring_bridge.py |
| **P2 状态+映射** | 四态状态机 + 强度 + 映射表→行为策略 | state_engine.py / mapping.py |
| **P3 编排+Agent** | 云 LLM + MCP 客户端，状态/语音双循环 + 护栏 | orchestrator.py |
| **P4 反馈闭环** | 游戏状态回读 + TTS/HUD 正负反馈 | feedback.py |
| **P5 稳定+演示** | watchdog/限速/兜底脚本/健康面板 + 彩排 | 可演示完整链路 |

---

## 10. 目录结构
```
d:\AdventureX2026\
├── stardew-bridge\        # 本项目（活跃开发）
│   ├── PRD.md             # 本文件
│   ├── python\            # ring_sound.py 已就位；桥接/状态/编排/反馈
│   ├── vendor\            # P0 clone StardewValley-MCP
│   └── dashboard\         # 可选 HUD（复用 garden-web）
├── archive\               # 旧版归档（garden-web + 9 份镜园文档）
├── materials\             # 戒指 SDK 源 + STEP 模型 + 备选创意集
├── ecc-frontend-skills\   # 前端技能
└── _ecc_tmp\              # ECC 源仓库
```

---

## 11. 风险与对策
| 风险 | 级别 | 对策 |
| --- | --- | --- |
| shadow farmer 在 1.6 寻路/工具兼容性 | 高 | P0 尽早实测；不通则以「指令级」替代「自主」模式 |
| 云 LLM/STT 现场网络抖动 | 中高 | 演示兜底脚本 + 关键动作预置 |
| 戒指模式互斥/切换不可靠 | 中 | 只用双击（不翻模式）+ 默认录音模式；睡眠走时间启发式 |
| 版权/不可交付 | 高（已接受） | 仅 demo、演示机备正版；突出自研映射与闭环叙事 |
| 原创性被质疑「只是遥控星露谷」 | 中 | 强调三层原创贡献（§1.3），弱化游戏本体 |

---

## 12. 前置条件与依赖
- 演示机：正版《星露谷物语》1.6 + SMAPI + .NET 6 + Node.js + Python 3.11 + ffmpeg + `bleak`。
- 云 LLM 与云 STT 的 API Key。
- 戒指 MAC 地址（`ring_sound.py` 按 MAC 连接）。
- 团队具备基础 C#/.NET 环境以编译 fork 的 MOD（改动量小）。

---

## 13. 术语表
- **shadow Farmer**：MOD 内不可见的农民实例，继承 Farmer 类，经游戏原生 API 执行工具/钓鱼/战斗。
- **companion NPC**：与 shadow Farmer 配对的可见角色（AI 农场助手）。
- **MCP**：Model Context Protocol，向 LLM 暴露游戏工具接口。
- **efficiency**：现实专注强度归一值，决定游戏行为节奏与产出。
- **safe-idle**：任一链路断开时的安全空转态，暂停下发、保持最后状态。
