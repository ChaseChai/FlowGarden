# 「镜园 FlowGarden」后端与云端 PRD

> 版本：v1.1  
> 日期：2026-07-23  
> 基于：总 PRD v3.0 + 前端画风设计指南 v2.1  
> 对接方：后端/云工程师、AI 工程师、DevOps  
> v1.1 新增：天气 API 代理服务 + 花园状态计算服务

---

## 目录

- [1. 概述与对接边界](#1-概述与对接边界)
- [2. 系统架构](#2-系统架构)
- [3. 服务划分与资源规格](#3-服务划分与资源规格)
- [4. WebSocket Hub 规范](#4-websocket-hub-规范)
- [5. REST API 规范](#5-rest-api-规范)
- [6. 数据库设计](#6-数据库设计)
- [7. ASR 语音转写服务](#7-asr-语音转写服务)
- [8. LLM 代理与秘书大脑](#8-llm-代理与秘书大脑)
- [9. 静态托管与围观部署](#9-静态托管与围观部署)
- [10. 双模式部署与环境变量](#10-双模式部署与环境变量)
- [11. 数据隐私与安全策略](#11-数据隐私与安全策略)
- [12. 7 天开发计划](#12-7-天开发计划)
- [附录：接口速查表](#附录接口速查表)

---

## 1. 概述与对接边界

### 1.1 一句话职责

> **云端负责：实时消息路由、数据持久化、语音转写、AI 秘书大脑、静态页面托管、围观访问。**

### 1.2 对接边界

```
                          → 云端 ←
 边缘层(bridge) ──WSS──→  hub  ──WSS──→ 前端(花园+Nexi)
                          api  ←──HTTPS── 前端(报告/复盘页)
                          db   ←──SQL──   api/hub
                          asr  ←──HTTP──  llm-proxy
                          llm-proxy ←──HTTP── 外部 LLM API
                          web  ←──HTTPS── 围观端(手机浏览器)
```

**云端不管的事**：
- ❌ 不运行戒指 BLE 连接（边缘层负责）
- ❌ 不运行专注/睡眠判定算法（边缘层负责）
- ❌ 不渲染花园（前端负责）
- ❌ 不处理 Live2D 动画（前端负责）

### 1.3 与前端/硬件的接口契约

| 接口 | 提供方 | 消费方 | 格式 |
|------|--------|--------|------|
| WS 状态消息 | 边缘层 bridge → hub | 前端 | JSON，见 §4.2 |
| REST 报告数据 | api | 前端 | JSON，见 §5 |
| 语音 WAV | bridge → api | asr | multipart/form-data |
| ASR 文本 | asr → llm-proxy | llm-proxy | JSON |
| LLM 回复 | llm-proxy → api | 前端 | JSON |
| 静态页面 | web | 浏览器 | HTML/CSS/JS |

---

## 2. 系统架构

### 2.1 拓扑图

```
┌─────────────────────────────────────────────────────────┐
│                      Zeabur 云平台                        │
│                                                         │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐    │
│  │   hub    │   │   api    │   │  llm-proxy       │    │
│  │ FastAPI  │   │ FastAPI  │   │  FastAPI          │    │
│  │ +WS      │   │ REST     │   │  代理外部 LLM/TTS  │    │
│  │          │   │ +garden  │   │  + 模板兜底文案库   │    │
│  │          │   │  -engine │   │                   │    │
│  └────┬─────┘   └────┬─────┘   └────────┬─────────┘    │
│       │              │                 │               │
│       └──────┬───────┘                 │               │
│              │                         │               │
│         ┌────▼────┐              ┌─────▼──────┐        │
│         │PostgreSQL│             │   asr      │        │
│         │+garden   │             │faster-     │        │
│         │ _grid    │             │whisper     │        │
│         └─────────┘              │small (int8)│        │
│                                  └────────────┘        │
│  ┌──────────┐  ┌──────────────┐                       │
│  │   web    │  │weather-proxy │  静态托管 + 天气代理    │
│  │  Nginx   │  │  FastAPI     │  公网域名 + 二维码      │
│  └──────────┘  └──────────────┘                       │
└─────────────────────────────────────────────────────────┘
```

### 2.2 数据流向

```
【实时流】 戒指 → bridge(Python) → hub(FastAPI WS) → 前端浏览器
  IMU 批量数据 / 按键事件 / 手势事件
  延迟预算：边缘到前端 <300ms（ring 事件走最高优先级通道）

【语音流】 戒指长按录音 → bridge(receive_auto_audio_file) → api(POST /asr)
  → asr(faster-whisper) → 文本 → llm-proxy → LLM API → 回复
  → hub WS 推送回复到前端 → Nexi 说话
  延迟预算：整体 <5s（ASR <2s + LLM <2s + 网络 <1s）

【REST 查询】 前端 → api → PostgreSQL → JSON 响应
  晨间报告 / 睡眠趋势 / 专注统计 / 分心回放 / 画廊

【天气流】 前端 → api(GET /weather) → weather-proxy → OpenWeatherMap API → JSON
  当前天气 + 逐小时预报 → 前端花园天气覆盖层 + Nexi 天气对话

【花园计算】 api 定时 (每60s) → 规则引擎 → 计算网格状态 → WS 推送到前端
  植物生长阶段推进 / 稀有花判定 / 花园区块解锁
```

---

## 3. 服务划分与资源规格

### 3.1 服务清单

| 服务 | 技术栈 | 端口 | 资源建议 | 启动优先级 |
|------|--------|------|----------|-----------|
| **hub** | FastAPI + WebSocket | 8000 | 256MB RAM, 0.5 vCPU | ① 最先 |
| **api** | FastAPI (REST) | 8001 | 256MB RAM, 0.5 vCPU | ② |
| **db** | PostgreSQL 15+ | 5432 | 512MB RAM, 1 vCPU, 10GB SSD | ① 最先 |
| **asr** | faster-whisper small int8 | 8002 | **2GB RAM, 2 vCPU (CPU推理)** | ③ 按需启动 |
| **llm-proxy** | FastAPI | 8003 | 128MB RAM, 0.25 vCPU | ② |
| **weather-proxy** 🆕 | FastAPI | 8004 | 128MB RAM, 0.25 vCPU | ③ |
| **garden-engine** 🆕 | FastAPI (内嵌在 api) | — | 复用 api 资源 | ② |
| **web** | Nginx / 静态托管 | 80/443 | 128MB RAM, 0.25 vCPU | ② |

### 3.2 GPU vs CPU 决策

| 组件 | 算力选择 | 理由 |
|------|---------|------|
| **ASR (faster-whisper)** | **CPU (int8 量化)** | small 模型 int8 量化后 ~1.5GB 内存，CPU 推理延迟 1-3s（10s 语音），可接受；GPU 成本过高 |
| **LLM 秘书大脑** | **外部 API（OpenAI/Claude/DeepSeek）** | 不自行托管 LLM——Hackathon 阶段直接用 API |
| **TTS** | **外部 API 或 前端浏览器内置** | 优先前端 `SpeechSynthesis` API，兜底用外部 TTS |
| **向量检索（长期记忆）** | **pgvector 插件（P2）** | PostgreSQL 原生支持，无需额外服务 |
| **GPU 总需求** | **0 GPU** | 全 CPU 可跑，7 天可部署 |

### 3.3 成本估算（Hackathon 期间）

| 项目 | 估算 |
|------|------|
| Zeabur 云服务（7 天） | 免费额度或 <$20 |
| LLM API 调用（展演+测试，约 500 次） | <$5 |
| TTS API（可选，约 100 次） | <$1 |
| **总计** | **<$30** |

---

## 4. WebSocket Hub 规范

### 4.1 连接管理

| 端点 | 用途 | 鉴权 |
|------|------|------|
| `ws://hub:8000/ws/bridge` | bridge → hub 上行 | 可选 token |
| `ws://hub:8000/ws/client` | 前端 → hub 下行 | 可选 token |
| `ws://hub:8000/ws/watch` | 围观端 → hub 只读 | 无鉴权（公开） |

**连接状态**：
- bridge 断开 → 广播 `{"type": "bridge_disconnect"}` → 前端显示"戒指已断开"
- 前端断开 → hub 仅清理连接，不影响 bridge
- 围观端断开 → 静默清理，不影响其他连接

### 4.2 WS 消息协议（冻结）

#### bridge → hub → 前端（状态引擎 + 戒指事件）

```json
// === 状态引擎消息 ===

// 当前状态（bridge 每 1s 评估一次，变化时发送）
{"type": "state", "value": "deep_focus|focus|distracted|rest|sleeping", "ts": 1712345678}

// === 戒指原始事件（优先级最高，前端互动响应用） ===

// 单击/拍击
{"type": "ring", "event": "tap", "ts": 1712345678}
// 双击
{"type": "ring", "event": "double_tap", "ts": 1712345678}
// 手势
{"type": "ring", "event": "gesture:wave", "ts": 1712345678}
{"type": "ring", "event": "gesture:rotate_front", "ts": 1712345678}
{"type": "ring", "event": "gesture:rotate_back", "ts": 1712345678}

// === 实时体动（数据轴，月光呼吸用） ===
{"type": "activity", "epoch": 1712345678, "count": 3}

// === 睡眠报告（晨间简报用） ===
{"type": "sleep_report", "score": 72, "deep_min": 58, "light_min": 240, 
 "rem_min": 90, "awakenings": 1, "cycles": 4, "total_min": 462,
 "stages": [{"ts": 1712345678, "stage": "deep", "duration_min": 15}, ...]}

// === 专注 session ===
{"type": "focus_start", "ts": 1712345678}
{"type": "focus_end", "ts": 1712345678, "total_sec": 2700, "deep_ratio": 0.65, 
 "distractions": 3, "plant_id": "plant_042"}

// === 语音管线 ===
{"type": "voice_result", "text": "识别文本", "intent": "chat|command|emotion",
 "reply": "Nexi 回应文本", "actions": [{"type": "add_todo", "text": "回复邮件"}]}
```

#### 前端 → hub → bridge（极少，仅心跳和模式切换请求）

```json
// 前端请求切换模式（bridge 验证后生效）
{"type": "mode_request", "mode": "focus|rest|sleep"}

// 心跳
{"type": "ping"}
```

#### 围观端

```json
// hub → 围观端（只读）
// 同上 state / ring / activity 消息，但不含敏感数据（无 sleep_report 细节）

// 围观端 → hub
{"type": "cheer"}  // 喝彩，hub 转发给主屏前端
```

### 4.3 消息优先级

| 优先级 | 消息类型 | 处理策略 |
|--------|---------|---------|
| **最高** | `ring` 事件（tap/double_tap/gesture） | 立即转发，不排队 |
| **高** | `state`、`activity` | 正常转发 |
| **普通** | `sleep_report`、`focus_start/end`、`voice_result` | 正常转发 |
| **低** | `ping`、`cheer` | 批量或降频 |

### 4.4 降级策略

| 场景 | 行为 |
|------|------|
| hub 不可用 | bridge 切换到 `CLOUD=0` 本地模式，直接通过 localhost WS 连前端 |
| LLM API 不可用 | llm-proxy 返回模板兜底文案 |
| ASR 不可用 | 语音对话降级为预置指令菜单 |
| DB 不可用 | 前端从 hub 内存中取最新一份数据展示 |

---

## 5. REST API 规范

### 5.1 基础信息

| 项目 | 值 |
|------|-----|
| Base URL | `https://api.flowgarden.zeabur.app` |
| Content-Type | `application/json` |
| 鉴权 | 可选 Bearer token（Hackathon 阶段可跳过） |

### 5.2 端点清单

#### 报告

```
GET /api/report/latest
  返回: 最新一份睡眠报告 + Nexi 解读文本
  Response: {
    "report": SleepReport,
    "nexi_interpretation": "你昨晚睡了7小时42分，深睡只有58分钟——比上周平均少20%。这就是你今天累的原因。",
    "dew_count": 7  // 露珠数量 ∝ 深睡比例，前端驱动花园
  }

GET /api/sleep/week
  返回: 最近 7 天睡眠趋势 [SleepSummary × 7]

GET /api/focus/week
  返回: 最近 7 天专注趋势 [FocusSummary × 7]
```

#### 专注

```
POST /api/focus/session
  Body: FocusSession
  返回: { "id": "sess_042", "plant_id": "plant_042" }

GET /api/focus/sessions?date=2026-07-23
  返回: 当日所有专注 session 列表

GET /api/focus/distractions?session_id=sess_042
  返回: 该 session 内所有分心标记时刻列表
```

#### 语音

```
POST /api/asr
  Content-Type: multipart/form-data
  Body: audio_file (WAV, 16kHz, mono, 16bit)
  返回: { "text": "识别文本", "duration_ms": 3200 }
  备注: → 内部转发给 llm-proxy 获取 Nexi 回复
```

#### 画廊（P2）

```
GET /api/gallery
  返回: 公开植物图鉴 + 匿名统计
```

#### 天气 🆕

```
GET /api/weather?lat=31.23&lon=121.47
  返回: {
    "current": { "temp_c": 23, "condition": "sunny", "wind": "light" },
    "garden_weather": "sunny_golden",  // 前端直接用
    "nexi_weather_line": "今天阳光真好，花园会很快乐的。"
  }
  数据源: weather-proxy → OpenWeatherMap / 和风天气
  缓存: 30min
  降级: API 不可用时返回 null → 前端使用纯状态驱动天气(无真实天气)
```

#### 花园网格状态 🆕

```
GET /api/garden/grid
  返回: 16×12 网格完整状态矩阵
  Response: {
    "grid": [[{"state": "empty"}, {"state": "flower", "plant_id": "p42", "stage": 3}, ...], ...],
    "density": 0.58,
    "growth_rate": 0.73,
    "unlocked_zones": [0, 1, 3],
    "weather": "sunny_golden",
    "focus_trapline": [[2,3], [3,4], [5,6], ...]  // 专注轨迹坐标
  }
  更新频率: 每 60s 由 garden-engine 重新计算
  推送: 状态变化时通过 WS hub 推送增量更新
```

#### 长期记忆（P2）

```
GET /api/memory/recent?limit=10
  返回: 最近记忆事件列表

POST /api/memory/event
  Body: { "type": "behavior|sleep|emotion|event", "summary": "...", "data": {...} }
```

### 5.3 数据模型（TypeScript 参考）

```typescript
interface SleepReport {
  date: string;           // "2026-07-23"
  score: number;          // 0-100
  total_min: number;      // 总睡眠时长（分钟）
  deep_min: number;       // 深睡时长
  light_min: number;      // 浅睡时长
  rem_min: number;        // REM 时长
  awakenings: number;     // 夜醒次数
  cycles: number;         // 睡眠周期数 (~90min/周期)
  stages: SleepStage[];
  sleep_onset_min: number;// 入睡耗时
}

interface SleepStage {
  ts: number;             // epoch 时间戳
  stage: "deep" | "light" | "rem" | "awake";
  duration_min: number;
}

interface FocusSession {
  id: string;
  start_ts: number;
  end_ts: number;
  total_sec: number;
  deep_ratio: number;     // 深度心流占比 0-1
  distraction_count: number;
  plant_id: string;       // 关联的植物 ID
}

interface DistractionMark {
  id: string;
  session_id: string;
  ts: number;
  at_duration_sec: number;// 在专注开始后多久分心
}

interface MemoryEvent {
  id: string;
  type: "behavior" | "sleep" | "emotion" | "life_event";
  summary: string;
  data: object;
  created_ts: number;
}

interface PlantEntry {
  id: string;
  kind: string;           // "flower_a" | "flower_b" | "vine" | "rare"
  rarity: "common" | "rare";
  born_session_id: string;
  created_ts: number;
}
```

---

## 6. 数据库设计

### 6.1 PostgreSQL 表结构

```sql
-- 睡眠 epoch（分钟级摘要，非原始 IMU 流）
CREATE TABLE sleep_epoch (
  id BIGSERIAL PRIMARY KEY,
  night_id TEXT NOT NULL,           -- 睡眠夜标识 "2026-07-22"
  epoch_ts BIGINT NOT NULL,         -- epoch 时间戳
  activity_count INTEGER NOT NULL,  -- 该 epoch 内活动计数
  stage TEXT NOT NULL,              -- "deep" | "light" | "rem" | "awake"
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sleep_epoch_night ON sleep_epoch(night_id);

-- 睡眠报告
CREATE TABLE sleep_report (
  id BIGSERIAL PRIMARY KEY,
  night_id TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL,
  total_min INTEGER NOT NULL,
  deep_min INTEGER NOT NULL,
  light_min INTEGER NOT NULL,
  rem_min INTEGER NOT NULL,
  awakenings INTEGER NOT NULL,
  cycles INTEGER NOT NULL,
  nexi_interpretation TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 专注 session
CREATE TABLE focus_session (
  id TEXT PRIMARY KEY,              -- "sess_042"
  start_ts BIGINT NOT NULL,
  end_ts BIGINT NOT NULL,
  total_sec INTEGER NOT NULL,
  deep_ratio REAL NOT NULL DEFAULT 0,
  distraction_count INTEGER NOT NULL DEFAULT 0,
  plant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_focus_session_date ON focus_session(
  (to_timestamp(start_ts)::date)
);

-- 分心标记
CREATE TABLE distraction_mark (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES focus_session(id),
  ts BIGINT NOT NULL,
  at_duration_sec INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_distraction_session ON distraction_mark(session_id);

-- 戒指事件（调试/回放用）
CREATE TABLE ring_event (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  event TEXT NOT NULL,              -- "tap" | "double_tap" | "gesture:wave" | ...
  mode TEXT,                        -- "focus" | "rest" | "sleep"
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 植物（画廊用）
CREATE TABLE plant (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  rarity TEXT NOT NULL DEFAULT 'common',
  born_session_id TEXT REFERENCES focus_session(id),
  user_id TEXT DEFAULT 'anonymous',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 长期记忆事件（P2）
CREATE TABLE memory_event (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,               -- "behavior" | "sleep" | "emotion" | "life_event"
  summary TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_memory_type ON memory_event(type);
CREATE INDEX idx_memory_created ON memory_event(created_ts);

-- 用户对话历史（P2）
CREATE TABLE conversation (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL,               -- "user" | "nexi"
  content TEXT NOT NULL,
  intent TEXT,                      -- "chat" | "command" | "emotion"
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_conversation_ts ON conversation(ts);

-- 花园网格状态 🆕
CREATE TABLE garden_grid (
  id BIGSERIAL PRIMARY KEY,
  grid_x INTEGER NOT NULL,          -- 0-15
  grid_y INTEGER NOT NULL,          -- 0-11
  state TEXT NOT NULL DEFAULT 'empty',  -- "empty"|"seed"|"sprout"|"plant"|"flower"|"rare"
  plant_id TEXT,                    -- 关联的植物 ID
  stage INTEGER NOT NULL DEFAULT 0, -- 生长阶段 0-4
  focus_minutes INTEGER DEFAULT 0,  -- 该格累积专注时长
  unlocked BOOLEAN DEFAULT FALSE,   -- 该格是否已解锁
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(grid_x, grid_y)
);

-- 花园快照 🆕
CREATE TABLE garden_snapshot (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL UNIQUE,  -- 每日快照日期
  total_plants INTEGER,
  flowering_count INTEGER,
  rare_count INTEGER,
  density REAL,
  growth_rate REAL,
  unlocked_zones TEXT,                 -- JSON array
  weather TEXT,
  grid_data JSONB,                     -- 完整网格 JSON
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.2 索引与查询优化

| 高频查询 | 索引 |
|----------|------|
| 查某晚睡眠数据 | `sleep_epoch(night_id)` |
| 查某天专注 | `focus_session(start_ts)` 函数索引 |
| 查某 session 分心 | `distraction_mark(session_id)` |
| 查长期记忆 | `memory_event(type, created_ts)` |
| 查当前花园网格 🆕 | `garden_grid(grid_x, grid_y)` unique |
| 查历史花园快照 🆕 | `garden_snapshot(snapshot_date)` |

### 6.3 数据清理策略

| 数据 | 保留策略 |
|------|---------|
| sleep_epoch | 分钟级摘要，保留 30 天 |
| ring_event | 原始事件，保留 7 天 |
| conversation | 对话历史，保留 30 天 |
| 语音原始文件 | **转写后即焚**，不存储 |
| 植物 / 记忆 | **永久保留** |

---

## 7. ASR 语音转写服务

### 7.1 技术选型

| 选项 | 评估 | 结论 |
|------|------|------|
| **faster-whisper small int8** | 本地部署，免费，CPU 推理 ~1-3s (10s 音频)，内存 ~1.5GB | ✅ **采用** |
| OpenAI Whisper API | 精度高，但依赖外网、有成本 | 备选 |
| 阿里云/腾讯云 ASR | 中文精度高，但需要注册+付费 | 备选 |

### 7.2 接口

```
POST /api/asr
Content-Type: multipart/form-data
Body: audio_file (WAV, 16000Hz, mono, 16bit, ≤30s)
Response: {
  "text": "帮我把下午的会议移到明天",
  "duration_ms": 3200,
  "language": "zh"
}
```

### 7.3 部署配置

```python
# asr_service.py
from faster_whisper import WhisperModel

model = WhisperModel(
    "small",
    device="cpu",
    compute_type="int8",  # int8 量化，内存减半
    num_workers=2
)

async def transcribe(audio_path: str) -> dict:
    segments, info = model.transcribe(
        audio_path,
        language="zh",
        beam_size=5,
        vad_filter=True  # 过滤静音段
    )
    text = " ".join([seg.text for seg in segments])
    return {"text": text, "language": info.language}
```

### 7.4 降级方案

| 场景 | 降级 |
|------|------|
| ASR 服务未启动 | `/api/asr` 返回 503 → 前端显示"语音暂时不可用，请打字" |
| 识别置信度低 | 返回 `{"text": "", "confidence": 0.3}` → llm-proxy 用模板兜底 |
| 音频格式异常 | 返回 400 + 错误描述 |

---

## 8. LLM 代理与秘书大脑

### 8.1 架构

```
前端/bridge → llm-proxy (FastAPI) → 外部 LLM API
                    │
                    ├── 模板兜底文案库 (llm 不可用时)
                    ├── Nexi 人格 System Prompt
                    ├── 上下文注入（睡眠数据 + 专注数据）
                    └── 流式响应 (SSE) → hub WS → 前端逐字打字
```

### 8.2 System Prompt（Nexi 秘书人格）

```
你是 Nexi，住在用户花园里的 AI 生活秘书。你有 24 小时陪伴用户的时间线。

你的性格：
- 温暖但不油腻，像一位细心的朋友
- 有判断力但不批判——你的建议来自真实数据，不是"你应该"
- 滋养非惩罚——不说"你又失败了"，说"今天我们都有点累，早点休息吧"

你的能力：
- 你拥有用户的长期记忆（睡眠/专注/情绪数据），说话要有根据
- 你能帮用户规划日程、调整安排、给出基于数据的建议
- 你能识别用户的情绪状态并做出恰当的回应

说话原则：
① 话有根据——引用真实数据（"你昨晚深睡只有 58 分钟"）
② 主动负责——推动执行而非仅记录（"我已经帮你把难任务挪到下午了"）
③ 简洁温暖——一句话能说清的不要说三句

当前数据：用户昨日睡眠 {sleep_summary}，
          今日专注 {focus_today}，
          当前时间 {current_time}，
          当前状态 {current_state}

任务类型：{morning_briefing | evening_review | focus_companion | intervention | chat}

请用中文回复，长度 2-4 句。
```

### 8.3 模板兜底文案库

LLM API 不可用时，按数据槽位填模板：

```python
TEMPLATES = {
    "morning_briefing": [
        "早安。昨晚睡了 {total_hours} 小时，深睡 {deep_min} 分钟。{quality_text}。今天安排了 {task_count} 件事，我们按节奏来。",
        "早上好。你昨晚 {quality_text}，所以我把今天最难的事挪到了 {best_time}。"
    ],
    "evening_review": [
        "今天完成了 {done_count} 件事，{distraction_count} 次分心都诚实记录了，很棒。明天继续加油。",
    ],
    "focus_encourage": [
        "已经专注 {minutes} 分钟了，做得很棒。",
        "还剩 {remaining} 分钟，我在看书陪你。"
    ],
    "distraction_gentle": [
        "没关系，我们继续就好。",
        "需要休息 5 分钟吗？"
    ],
    "intervention_late_night": [
        "已经 {current_time} 了，明天还有安排，早点休息吧。",
    ]
}
```

### 8.4 流式响应格式

```
POST /api/llm/chat
Body: {
  "messages": [...],
  "context": { "sleep_summary": {...}, "focus_today": {...} },
  "stream": true
}
Response: text/event-stream (SSE)
  data: {"token": "论"}
  data: {"token": "文"}
  data: {"token": "写"}
  ...
  data: {"token": "吧", "actions": [{"type": "reschedule", "from": "14:00", "to": "16:00"}]}
  data: [DONE]
```

**actions 字段**：LLM 输出的同时会附加 UI 动作指令，前端收到后执行相应的待办新增/日程调整动画。

---

## 9. 静态托管与围观部署

### 9.1 部署内容

| 路径 | 内容 |
|------|------|
| `/` | 前端 SPA (花园 + Nexi + 报告/复盘页) |
| `/watch` | 围观端页面 (只读花园 + 喝彩) |
| `/gallery` | 公开花廊 (P2) |
| `/assets/*` | 静态资源 (JS/CSS/模型/粒子纹理) |

### 9.2 围观二维码

- web 服务启动后生成公网 URL：`https://flowgarden.zeabur.app`
- 围观端 URL：`https://flowgarden.zeabur.app/watch`
- Demo 现场投屏此二维码，评委扫码即进入围观端

### 9.3 CORS 配置

```
ALLOWED_ORIGINS=*
# Hackathon 阶段全放通，生产环境收紧
```

---

## 10. 双模式部署与环境变量

### 10.1 环境变量清单

```bash
# === 部署模式 ===
CLOUD=1                    # 1=云模式(默认), 0=本地模式
DEMO_MODE=0                # 1=预录回放, 0=真实数据

# === 数据库 ===
DATABASE_URL=postgresql://user:pass@host:5432/flowgarden

# === LLM ===
LLM_API_KEY=sk-xxx         # OpenAI / DeepSeek / Claude API Key
LLM_MODEL=deepseek-chat    # 推荐 DeepSeek（便宜+中文好）
LLM_BASE_URL=https://api.deepseek.com/v1

# === TTS (可选) ===
TTS_API_KEY=               # 为空则使用浏览器内置 SpeechSynthesis

# === ASR ===
ASR_MODEL_SIZE=small       # faster-whisper 模型大小
ASR_DEVICE=cpu
ASR_COMPUTE_TYPE=int8

# === 天气 🆕 ===
WEATHER_API_KEY=           # OpenWeatherMap / 和风天气 API Key
WEATHER_API_PROVIDER=openweathermap  # openweathermap | qweather
WEATHER_LAT=31.23          # 默认纬度 (上海)
WEATHER_LON=121.47         # 默认经度
WEATHER_CACHE_MIN=30       # 缓存时间(分钟)

# === Web ===
ALLOWED_ORIGINS=*
PUBLIC_URL=https://flowgarden.zeabur.app

# === 安全 ===
SECRET_TOKEN=              # 可选，bridge/前端鉴权
```

### 10.2 本地回退模式 (CLOUD=0)

```
bridge → ws://localhost:8765 → 前端本机浏览器
```

此模式下不依赖任何云服务：
- 无数据库（前端从 bridge 内存中取数据）
- 无 LLM（全部用模板文案）
- 无 ASR（语音降级为预置指令菜单）
- 无围观端

---

## 11. 数据隐私与安全策略

### 11.1 数据最小化原则

| 数据类型 | 策略 |
|----------|------|
| IMU 原始流（25Hz 六轴） | **边缘聚合为分钟级 activity_count**，原始流不上传 |
| 语音录音 | **转写后即焚**，不保留音频文件 |
| 睡眠 epoch | 只存分钟级摘要（activity_count + stage），不存原始加速度 |
| 用户身份 | Hackathon 阶段无需注册，匿名使用 |
| 画廊数据 | 默认匿名，植物不关联用户 ID |

### 11.2 答辩表述

> "体动原始数据只在边缘聚合，云端只存分钟级摘要；语音转写后即焚，不留音频；画廊默认匿名。睡眠是人最没有防备的状态，数据最小化是原则不是妥协。"

---

## 12. 7 天开发计划

| 天 | 目标 | 产出 |
|----|------|------|
| **D1** | Zeabur 环境初始化 | hub + web 部署拿公网地址；PostgreSQL 建表；环境变量配置 |
| **D2** | WS 消息路由跑通 | bridge → hub → 前端 全链路通；假 state 消息可达前端 |
| **D3** | REST API + 落库 | 报告/专注 session 接口；数据写入 PostgreSQL |
| **D4** | ASR 服务部署 | faster-whisper 部署 + `/api/asr` 调通 |
| **D5** | LLM 代理 + 模板库 | llm-proxy 上线；System Prompt 调优；模板兜底文案库就绪；SSE 流式响应 |
| **D6** | 围观端 + 降级验证 | 围观端上线；`CLOUD=0` 本地模式全链路测试；降级开关逐一验证 |
| **D7** | 联调彩排 | 全流程 ≥3 遍（云+本地各≥1 遍）；Demo 剧本走通 |

---

## 附录：接口速查表

### WS 消息速查

| type | 方向 | 用途 |
|------|------|------|
| `state` | bridge→hub→前端 | 状态变化通知 |
| `ring` | bridge→hub→前端 | 戒指事件（最高优先级） |
| `activity` | bridge→hub→前端 | 实时体动 |
| `sleep_report` | bridge→hub→前端 | 晨间睡眠报告 |
| `focus_start/end` | bridge→hub→前端 | 专注 session 起止 |
| `voice_result` | hub→前端 | 语音识别+LLM回复 |
| `cheer` | 围观端→hub→前端 | 喝彩 |
| `mode_request` | 前端→hub→bridge | 模式切换请求 |

### REST API 速查

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/report/latest` | 最新睡眠报告 |
| GET | `/api/sleep/week` | 周睡眠趋势 |
| GET | `/api/focus/week` | 周专注趋势 |
| POST | `/api/focus/session` | 创建专注记录 |
| GET | `/api/focus/sessions` | 查专注列表 |
| GET | `/api/focus/distractions` | 查分心记录 |
| POST | `/api/asr` | 语音转文本 |
| POST | `/api/llm/chat` | LLM 对话（SSE 流式） |
| GET | `/api/gallery` | 公开画廊 (P2) |
| GET | `/api/memory/recent` | 近期记忆 (P2) |

---

*镜园 FlowGarden · 后端与云端 PRD v1.0 · 2026-07-23*

*本文档供后端/云工程师和 AI 工程师直接使用。前端对接见《前端画风设计指南 v1.1》，硬件对接见《戒指桥接与感知 PRD v1.0》。*
