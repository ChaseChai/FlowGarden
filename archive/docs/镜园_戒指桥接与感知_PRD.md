# 「镜园 FlowGarden」戒指桥接与感知 PRD

> 版本：v1.0  
> 日期：2026-07-23  
> 基于：总 PRD v3.0 + ring_sound.py SDK v0.3.4 + 协议文档 v4  
> 对接方：硬件/嵌入式工程师、算法工程师、Python 后端工程师  
> 文档状态：开发就绪

---

## 目录

- [1. 概述与对接边界](#1-概述与对接边界)
- [2. 硬件能力矩阵](#2-硬件能力矩阵)
- [3. ring_bridge 架构设计](#3-ring_bridge-架构设计)
- [4. 事件总线与消息协议](#4-事件总线与消息协议)
- [5. 专注判定算法](#5-专注判定算法)
- [6. 睡眠趋势算法](#6-睡眠趋势算法)
- [7. 18 格交互映射表（冻结）](#7-18-格交互映射表冻结)
- [8. 数据源抽象与预录回放](#8-数据源抽象与预录回放)
- [9. BLE 连接与错误处理](#9-ble-连接与错误处理)
- [10. 双模式上传](#10-双模式上传)
- [11. 性能与延迟预算](#11-性能与延迟预算)
- [12. 7 天开发计划](#12-7-天开发计划)
- [附录：SDK 接口速查](#附录sdk-接口速查)

---

## 1. 概述与对接边界

### 1.1 一句话职责

> **边缘层负责：BLE 连接管理、IMU 数据采集、事件聚合、专注/睡眠判定、模式状态机、双数据源切换、云端/本地双模式上传。**

### 1.2 硬件哲学

> **戒指是哑终端。** 戒指 = 6 原语输入器 + 1 盏不可编程的灯。它不能震动、不能发声、LED 不可编程、模式不可程序切换、不跑任何算法。所有智能都在 bridge / 云端 / 前端。

**答辩话术**：
> "戒指在我们系统里只是一枚传感器和开关——刻意的。感知的智能在算法层，表达的温度在花园里。硬件越简单，系统越可迁移：明天换任何一个带 IMU 的穿戴设备，镜园照样活着。"

### 1.3 对接边界

```
戒指 (固件 v2.0)               边缘层 (Python bridge)           云端+前端
┌─────────────┐   BLE    ┌─────────────────────────┐   WSS    ┌──────────┐
│ IMU (25Hz)  │ ──────→ │ ring_bridge.py          │ ──────→ │ hub/前端  │
│ 按键(单击/双击)│ ──────→ │  · 事件总线 RingEvent     │         │          │
│ 手势×3      │ ──────→ │  · 专注判定 focus_detector│         │          │
│ 录音        │ ──────→ │  · 睡眠趋势 actigraphy    │         │          │
│ LED(固件)   │          │  · 数据源抽象 SensorSource│         │          │
└─────────────┘          │  · 预录回放 DemoSource    │         │          │
                         └─────────────────────────┘         └──────────┘
```

**边缘层不管的事**：
- ❌ 不渲染花园（前端负责）
- ❌ 不运行 LLM（云端负责）
- ❌ 不存储历史数据（云端 DB 负责）
- ❌ 不做语音转写（云端 ASR 负责）

---

## 2. 硬件能力矩阵

### 2.1 戒指设备参数

| 参数 | 值 |
|------|-----|
| SDK 版本 | ring_sound.py v0.3.4 |
| 协议版本 | v4 |
| 固件版本 | V2.000.0001.0015 |
| 通信方式 | BLE (Nordic UART Service) |
| IMU | 六轴（加速度计 + 陀螺仪） |
| IMU 采样率 | 25Hz（批量上报，每批 ≤32 采样） |
| 按键 | 物理按键，支持单击/双击 |
| 手势识别 | HMM 模型，识别 wave / rotate_front / rotate_back |
| 录音 | 双声道 PDM，Speex 编码 |
| LED | 绿=录音中，红=手势中，红闪=失败（固件固定，不可编程） |
| 电池 | 可充电锂电 |
| MAC 地址 | 配置项，SDK 按 MAC 扫描直连 |

### 2.2 六原语能力表

| # | 原语 | 协议 | SDK 函数 | 数据特征 | 系统语义 |
|---|------|------|----------|----------|----------|
| 1 | **IMU 六轴流** | `0x0605` | `start_sensor_report()` / `wait_sensor_data()` | 25Hz 批量，每批 ≤32 采样 | **唯一连续数据源**：专注判定、睡眠分期原料 |
| 2 | **单击(拍击)** | `0x0704` | `wait_sensor_key_single_press_event()` | 事件，~500ms 双击窗口后到达 | 诚实标记分心 / 击掌互动 |
| 3 | **双击** | `0x0703` | `wait_sensor_key_double_press_event()` | 事件，排他 | 模式开关（专注起止、起床） |
| 4 | **手势 wave** | `0x0702` | `wait_sensor_gesture_event()` | 事件 | 召唤 Nexi、休息互动 |
| 5 | **手势 rotate_front** | `0x0702` | `wait_sensor_gesture_event()` | 事件 | 种新种子 |
| 6 | **手势 rotate_back** | `0x0702` | `wait_sensor_gesture_event()` | 事件 | 切换天气/皮肤 |
| 7 | **录音** | `0x0505` | `receive_auto_audio_file()` | 长按触发，Speex→WAV | 语音对话原料 |
| — | **LED** | 固件固定 | 不可编程 | 绿=录音 / 红=手势 | **不入产品语义**，仅底层状态提示 |

### 2.3 硬件约束（必须遵守）

| 约束 | 说明 | 代码层面 |
|------|------|----------|
| **IMU 需手势模式** | `start_sensor_report()` 仅在设备处于手势模式时生效，录音模式返回错误码 2 | bridge 软状态机 + `0x0601` 探测纠错 |
| **并发互斥** | `receive_auto_audio_file()` 不与 `download_audio_file()` 并发（共享 `0x0505` 队列） | 加锁或队列化 |
| **同一连接单命令** | 同一时间只发一个"命令-响应"请求，事件监听可并行 | 命令队列 |
| **断连不伪造数据** | BLE 断开后睡眠曲线标记"未知段"，不插值伪造 | 在 sleep_epoch 中标记 stage="unknown" |
| **睡眠防误触** | 睡眠模式在应用层屏蔽手势与单击 | 模式状态机过滤 |
| **录音自动上报** | 长按录音结束后设备自动通过 `0x0505` 连续上报，不需要主动请求 | 注册 `receive_auto_audio_file()` 处理器 |
| **低电量保护** | 电量 <20% 时设备可能拒绝部分操作 | `get_system_info()` 监控电量 |

---

## 3. ring_bridge 架构设计

### 3.1 模块结构

```
ring_bridge/
├── main.py                 # 入口：启动即运行，按环境变量切换
├── config.py               # 配置：MAC地址、CLOUD开关、DEMO_MODE、阈值
├── event_bus.py            # 事件总线：RingEvent 定义 + 发布订阅
├── ring_client.py          # 戒指客户端：BLE连接 + SDK调用 + 心跳
├── focus_detector.py       # 专注判定：5s 滑窗方差+过零率
├── actigraphy.py           # 睡眠趋势：60s epoch 体动分期
├── activity_aggregator.py  # 体动聚合：原始IMU流→分钟级activity_count
├── mode_state_machine.py   # 模式状态机：focus/rest/sleep + 18格映射
├── ws_uploader.py          # WS上传：CLOUD=1→Zeabur / CLOUD=0→localhost
├── sensor_source.py        # 数据源抽象：SensorSource协议
├── ring_source.py          # RingSource：真戒指实现
├── demo_source.py          # DemoSource：预录回放实现
├── demo_data/              # 预录数据文件
│   ├── demo_sleep.json     # 预录睡眠数据
│   ├── demo_focus.json     # 预录专注数据
│   └── demo_events.json    # 预录戒指事件序列
└── templates/              # 模板文案
    └── fallback_texts.json
```

### 3.2 主循环

```python
# main.py 伪代码

async def main():
    config = load_config()
    
    # 选择数据源
    if config.DEMO_MODE:
        source = DemoSource("demo_data/")
    else:
        source = RingSource(config.RING_MAC)
        await source.connect()
    
    # 初始化引擎
    focus_detector = FocusDetector()
    actigraphy = ActigraphyEngine()
    aggregator = ActivityAggregator()
    mode_sm = ModeStateMachine()
    uploader = WsUploader(config.CLOUD)
    
    # 主循环
    async for event in source.event_stream():
        # 1. 发布原始事件到总线
        event_bus.publish(event)
        
        # 2. 状态引擎处理
        if event.type == "imu_batch":
            activity = aggregator.feed(event.data)
            focus_state = focus_detector.update(event.data)
            sleep_stage = actigraphy.update(activity)
            
            # 状态变化时推送
            if focus_state.changed:
                await uploader.send({"type": "state", "value": focus_state.value})
            if activity.epoch_ready:
                await uploader.send({"type": "activity", "epoch": activity.ts, "count": activity.count})
        
        elif event.type in ("tap", "double_tap", "gesture"):
            # 戒指事件 → 模式状态机 → 18格映射
            action = mode_sm.process(event)
            if action:
                # 最高优先级上传
                await uploader.send_priority({"type": "ring", "event": action})
        
        elif event.type == "audio":
            await uploader.upload_audio(event.data)
```

---

## 4. 事件总线与消息协议

### 4.1 RingEvent 定义

```python
from dataclasses import dataclass
from typing import Optional, List
import time

@dataclass
class RingEvent:
    type: str           # "imu_batch" | "tap" | "double_tap" | "gesture" | "audio" | "disconnect"
    ts: float           # 事件时间戳
    data: Optional[dict] = None
    payload: Optional[bytes] = None

# IMU 批量数据结构
@dataclass
class ImuSample:
    ts: float
    accel_x: float
    accel_y: float
    accel_z: float
    gyro_x: float
    gyro_y: float
    gyro_z: float

# IMU 批量事件
# RingEvent(type="imu_batch", ts=..., data={"samples": List[ImuSample]})
```

### 4.2 边缘聚合

原始 25Hz IMU 流在边缘层聚合成分钟级活动计数后上传，原始流不上传云端。

```python
# activity_aggregator.py

class ActivityAggregator:
    """IMU 原始流 → 分钟级活动计数"""
    
    def __init__(self, epoch_sec: int = 60):
        self.epoch_sec = epoch_sec
        self.buffer: List[float] = []  # |accel| 值缓冲
        self.current_epoch_ts = None
    
    def feed(self, samples: List[ImuSample]) -> Optional[ActivityEpoch]:
        """输入 IMU 采样，输出完成的 epoch（如果有）"""
        for s in samples:
            mag = (s.accel_x**2 + s.accel_y**2 + s.accel_z**2) ** 0.5
            self.buffer.append(mag)
        
        # 检查是否完成了一个 epoch
        epoch_ts = int(samples[0].ts // self.epoch_sec) * self.epoch_sec
        if epoch_ts != self.current_epoch_ts and self.buffer:
            count = sum(1 for m in self.buffer if m > self.threshold)
            result = ActivityEpoch(ts=epoch_ts, count=count)
            self.buffer = []
            self.current_epoch_ts = epoch_ts
            return result
        return None
```

---

## 5. 专注判定算法

### 5.1 算法设计

```
输入: 5s 滑窗 IMU 加速度数据
输出: deep_focus | focus | distracted
更新频率: 每秒评估一次，状态变化时推送

判定逻辑:
  variance = 窗口内 |accel| 的方差
  zero_crossing = 窗口内 |accel| 过零次数

  if variance < THRESHOLD_DEEP and zero_crossing < THRESHOLD_ZC:
      state = "deep_focus"    # 深度心流：手几乎不动
  elif variance < THRESHOLD_FOCUS:
      state = "focus"          # 浅度专注：微小动作
  else:
      state = "distracted"     # 分心：明显运动
```

### 5.2 参数配置

```python
# config.py

FOCUS_CONFIG = {
    "window_sec": 5,            # 滑窗大小
    "step_sec": 1,              # 评估步长
    "threshold_deep": 0.002,    # 深度心流方差阈值
    "threshold_focus": 0.008,   # 专注方差阈值
    "threshold_zc": 3,          # 过零次数阈值
    "hysteresis_sec": 3,        # 防抖：状态切换需持续 N 秒
}

# 调参建议: 现场用戒指实际佩戴数据校准阈值
```

### 5.3 伪代码

```python
class FocusDetector:
    def __init__(self):
        self.window = deque(maxlen=5 * 25)  # 5s × 25Hz = 125 采样
        self.current_state = "focus"
        self.state_duration = 0
    
    def update(self, samples: List[ImuSample]) -> Optional[str]:
        for s in samples:
            mag = (s.accel_x**2 + s.accel_y**2 + s.accel_z**2) ** 0.5
            self.window.append(mag)
        
        if len(self.window) < self.window.maxlen:
            return None
        
        variance = statistics.variance(self.window)
        zc = sum(1 for i in range(1, len(self.window)) 
                 if (self.window[i] - 1.0) * (self.window[i-1] - 1.0) < 0)
        
        if variance < THRESHOLD_DEEP and zc < THRESHOLD_ZC:
            new_state = "deep_focus"
        elif variance < THRESHOLD_FOCUS:
            new_state = "focus"
        else:
            new_state = "distracted"
        
        # 防抖
        if new_state != self.current_state:
            self.state_duration += 1
            if self.state_duration >= HYSTERESIS_SEC:
                self.current_state = new_state
                self.state_duration = 0
                return new_state
        else:
            self.state_duration = 0
        
        return None  # 无变化
```

### 5.4 验收标准

| 场景 | 预期状态 | 反应时间 |
|------|---------|---------|
| 手完全静止放在桌上 | deep_focus | ~5s |
| 手放键盘上偶尔微动 | focus | ~3s |
| 挥手/站起来走动 | distracted | ~3s |
| distracted → focus | focus（防抖 3s） | ~3s |
| focus → deep_focus | deep_focus（防抖 3s） | ~3s |

---

## 6. 睡眠趋势算法

### 6.1 算法设计

医学经典 actigraphy，60s epoch：

```
输入: 分钟级 activity_count
输出: deep | light | rem | awake

判定逻辑 (per epoch):
  activity_count == 0        → deep (深睡)
  1 <= activity_count <= 2   → light (浅睡)
  3 <= activity_count <= 8   → rem (快速眼动，手指微动——戒指独特优势)
  activity_count > 8         → awake (醒)
```

### 6.2 代码

```python
class ActigraphyEngine:
    STAGE_MAP = {
        (0, 0): "deep",
        (1, 2): "light",
        (3, 8): "rem",
        (9, float("inf")): "awake"
    }
    
    def classify(self, activity_count: int) -> str:
        for (lo, hi), stage in self.STAGE_MAP.items():
            if lo <= activity_count <= hi:
                return stage
        return "awake"
    
    def derive_metrics(self, epochs: List[dict]) -> dict:
        """从 epoch 列表计算衍生指标"""
        total = len(epochs)  # 总分钟数
        deep_count = sum(1 for e in epochs if e["stage"] == "deep")
        light_count = sum(1 for e in epochs if e["stage"] == "light")
        rem_count = sum(1 for e in epochs if e["stage"] == "rem")
        awake_count = sum(1 for e in epochs if e["stage"] == "awake")
        
        # 周期数：~90min/周期
        cycles = total // 90
        
        # 综合评分
        deep_ratio = deep_count / max(total, 1)
        score = int(deep_ratio * 40 + (total / 480) * 30 + (cycles / 5) * 30)
        score = min(100, max(0, score))
        
        return {
            "total_min": total,
            "deep_min": deep_count,
            "light_min": light_count,
            "rem_min": rem_count,
            "awakenings": sum(1 for i in range(1, len(epochs))
                            if epochs[i]["stage"] == "awake" and epochs[i-1]["stage"] != "awake"),
            "cycles": cycles,
            "score": score
        }
```

### 6.3 诚实边界声明

> ⚠️ 本算法定位为**消费级趋势参考**，不宣称医疗精度。
> 不做 PSG 对标，不做医学诊断。
> 睡眠分期算法逻辑可在展演现场讲解和验证。
> "不画大饼"本身就是答辩加分项。

### 6.4 验收标准

| 场景 | 预期 |
|------|------|
| 输入预录一晚数据（6-8h） | 输出完整分期序列 + 衍生指标 |
| 输入 3 分钟模拟数据 | 可演示分期变化（深睡→浅睡→REM→醒） |
| 断连段 | 标记 stage="unknown"，不伪造不插值 |

---

## 7. 18 格交互映射表（冻结，D1 写入常量）

### 7.1 映射表

```
| 模式＼原语      | 单击(0x0704)           | 双击(0x0703)         | wave              | rotate_front   | rotate_back    |
|----------------|------------------------|----------------------|-------------------|----------------|----------------|
| **专注**       | 标记分心(落叶+诚实记账)   | 结束专注→结算         | — 忽略             | — 忽略          | — 忽略          |
| **休息**       | 击掌/触发分身小动作       | 进入专注              | 召唤分身走近        | 种新种子         | 切换天气         |
| **睡眠**       | — 忽略(防翻身误触)       | 起床→晨间报告          | — 忽略             | — 忽略          | — 忽略          |
```

### 7.2 实现

```python
# mode_state_machine.py

INTERACTION_MAP = {
    "focus": {
        "tap":        "mark_distraction",
        "double_tap": "end_focus",
        "gesture:wave": None,           # 忽略
        "gesture:rotate_front": None,
        "gesture:rotate_back": None,
    },
    "rest": {
        "tap":        "avatar_high_five",
        "double_tap": "start_focus",
        "gesture:wave": "avatar_come_closer",
        "gesture:rotate_front": "plant_new_seed",
        "gesture:rotate_back": "switch_weather",
    },
    "sleep": {
        "tap":        None,              # 防翻身误触
        "double_tap": "wake_up_report",
        "gesture:wave": None,
        "gesture:rotate_front": None,
        "gesture:rotate_back": None,
    },
}

class ModeStateMachine:
    def __init__(self):
        self.mode = "rest"  # 默认休息模式
    
    def process(self, event: RingEvent) -> Optional[str]:
        """根据当前模式和戒指事件，返回对应的系统动作"""
        
        # 确定事件类型
        if event.type == "tap":
            key = "tap"
        elif event.type == "double_tap":
            key = "double_tap"
        elif event.type == "gesture":
            key = f"gesture:{event.data['gesture']}"
        else:
            return None
        
        action = INTERACTION_MAP[self.mode].get(key)
        
        # 模式切换动作（全局处理）
        if action == "start_focus":
            self.mode = "focus"
        elif action == "end_focus":
            self.mode = "rest"
        elif action == "wake_up_report":
            self.mode = "rest"
        
        return action
```

### 7.3 规则

1. **D1 定稿写入常量**，之后只调表现层、不改语义。
2. **任何未映射事件一律忽略**，不产生副作用，不抛异常。
3. **睡眠模式在应用层屏蔽手势与单击**（防翻身误触），仅双击有效。
4. **300ms 原则**：ring 事件 → action 字符串 → 上传 WS → 前端视觉响应，全链路 <300ms。

---

## 8. 数据源抽象与预录回放

### 8.1 SensorSource 协议

```python
from typing import Protocol, AsyncIterator

class SensorSource(Protocol):
    """数据源抽象：戒指、手环、手机 IMU 都实现同一接口"""
    
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    def event_stream(self) -> AsyncIterator[RingEvent]: ...
    async def get_system_info(self) -> dict: ...
```

### 8.2 RingSource（真戒指）

```python
class RingSource:
    def __init__(self, mac: str):
        self.mac = mac
        self.client: Optional[RingSoundClient] = None
    
    async def connect(self):
        self.client = RingSoundClient()
        await self.client.connect(self.mac)
        await self.client.enable_time_sync()
        await self.client.start_sensor_report()
    
    async def event_stream(self) -> AsyncIterator[RingEvent]:
        """并发监听 IMU + 按键 + 手势 + 录音"""
        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._imu_loop())
            tg.create_task(self._key_loop())
            tg.create_task(self._gesture_loop())
            tg.create_task(self._audio_loop())
```

### 8.3 DemoSource（预录回放）

```python
class DemoSource:
    """从 JSON 文件回放预录数据，用于 Demo 兜底"""
    
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.events: List[RingEvent] = []
    
    async def connect(self):
        # 加载预录数据文件
        self.events = self._load_events()
    
    async def event_stream(self) -> AsyncIterator[RingEvent]:
        """按时间戳顺序回放事件"""
        prev_ts = self.events[0].ts
        start = time.time()
        
        for event in self.events:
            # 保持原始时间间隔
            delay = (event.ts - prev_ts)
            await asyncio.sleep(delay)
            prev_ts = event.ts
            yield event
    
    def _load_events(self) -> List[RingEvent]:
        events = []
        # 加载 demo_sleep.json → 构造 sleep epochs
        # 加载 demo_focus.json → 构造 focus sessions + IMU 数据
        # 加载 demo_events.json → 构造 tap/double_tap/gesture 事件
        return sorted(events, key=lambda e: e.ts)
```

### 8.4 切换方式

```python
# main.py
if config.DEMO_MODE:
    source = DemoSource("demo_data/")
else:
    source = RingSource(config.RING_MAC)

# 上层引擎完全无感知
await source.connect()
async for event in source.event_stream():
    # ... 处理逻辑完全相同 ...
```

---

## 9. BLE 连接与错误处理

### 9.1 连接流程

```
1. scan_rings(mac_filter=MAC)         # 扫描戒指
2. RingSoundClient.connect(MAC)       # BLE 连接
3. enable_time_sync()                 # 校时
4. get_system_info()                  # 读取电量/固件版本
5. [用户单击切手势模式] start_sensor_report()  # 开启 IMU 流
6. 并发监听: IMU + 按键 + 手势 + 录音
```

### 9.2 模式探测纠错

```python
async def ensure_gesture_mode(client):
    """确保戒指处于手势模式（IMU 上报的前提）"""
    try:
        await client.start_sensor_report()
    except DeviceError as e:
        if e.code == 2:  # 录音模式
            logger.info("戒指处于录音模式，需用户单击切换。提示用户单击按键。")
            # 前端显示引导："请单击戒指按键进入手势模式"
            raise NeedUserAction("请单击戒指按键")
        else:
            raise
```

### 9.3 断连恢复

```python
MAX_RECONNECT_ATTEMPTS = 5
RECONNECT_BACKOFF_BASE = 1  # 秒

async def reconnect_loop(source):
    for attempt in range(MAX_RECONNECT_ATTEMPTS):
        try:
            await source.connect()
            return True
        except Exception:
            delay = RECONNECT_BACKOFF_BASE * (2 ** attempt)  # 指数退避: 1,2,4,8,16s
            logger.warning(f"重连失败 {attempt+1}/{MAX_RECONNECT_ATTEMPTS}，{delay}s 后重试")
            await asyncio.sleep(delay)
    
    logger.error("重连失败，切换到 DEMO_MODE 或等待手动干预")
    return False
```

**断连期间**：
- 睡眠 epoch 标记 `stage="unknown"`，不伪造不插值
- 前端显示连接指示 🟡→🔴
- BLE 断开后设备自动停 `0x0605` 上报，重连后需重发 `0x0601`

### 9.4 异常处理总表

| 异常 | 处理 |
|------|------|
| `TransportError` (设备未找到) | 提示用户检查戒指是否开机/在范围内 |
| `ProtocolError` (CRC/包头) | 丢弃该包，记录 warning 日志 |
| `TimeoutError` (等待超时) | 重试 3 次，仍失败则标记断连 |
| `DeviceError` (设备错误码) | 根据错误码分类处理（see SDK docs） |
| `AudioDecodeError` | 提示用户"语音录制异常，请重试" |
| `SpeexDecoderUnavailable` | 检查 ffmpeg 是否安装 |

---

## 10. 双模式上传

### 10.1 云模式 (CLOUD=1)

```python
class WsUploader:
    def __init__(self, cloud: bool):
        if cloud:
            self.url = "wss://hub.flowgarden.zeabur.app/ws/bridge"
        else:
            self.url = "ws://localhost:8765/ws/bridge"
    
    async def send(self, message: dict):
        await self.ws.send(json.dumps(message))
    
    async def send_priority(self, message: dict):
        """ring 事件走最高优先级——直接发送，不排队"""
        await self.ws.send(json.dumps(message))
    
    async def upload_audio(self, wav_bytes: bytes):
        """语音上传到 /api/asr，不走 WS"""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.flowgarden.zeabur.app/api/asr",
                files={"audio_file": wav_bytes}
            )
            return resp.json()
```

### 10.2 本地回退 (CLOUD=0)

- bridge 启动本地 WS server（`ws://localhost:8765`）
- 前端直接连 `ws://localhost:8765`
- 不依赖任何云服务
- ASR/LLM 功能降级为模板/预置指令

---

## 11. 性能与延迟预算

### 11.1 延迟预算

| 链路 | 目标延迟 | 备注 |
|------|---------|------|
| 戒指 IMU → bridge 收到 | <50ms | BLE 通知延迟 |
| ring 事件 → WS 上传 | <50ms | 内存操作 + 网络 |
| ring 事件 → 前端视觉回应 | **<300ms** | 总目标（PRD 冻结要求） |
| IMU → activity_count 聚合 | <100ms | 边缘计算 |
| 专注状态判定 | <500ms | 5s 滑窗 + 防抖 |
| 语音 → ASR 结果 | <3s | CPU faster-whisper small int8 |
| 语音 → LLM 回复 → 前端 | <5s | ASR + LLM + 网络 |

### 11.2 吞吐量

| 数据流 | 速率 | 带宽 |
|--------|------|------|
| IMU 原始流 | 25Hz × 6 轴 × 12B ≈ 1.8KB/s | 不上传云端 |
| activity_count (聚合后) | 1/60 Hz × 8B ≈ 0.13B/s | 上传云端 |
| ring 事件 | 峰值 ~1/s | <100B/msg |
| state 消息 | 变化时 ~1/10s | <100B/msg |

---

## 12. 7 天开发计划

| 天 | 目标 | 产出 |
|----|------|------|
| **D1** | BLE 链路 + 事件总线 | ring_bridge 骨架；`scan_rings()` + `connect()` 跑通；RingEvent 定义；18 格映射表写入常量 |
| **D2** | 双引擎 + WS 上传 | focus_detector + actigraphy 用预录数据验证；WS 上传到 hub 跑通；activity_aggregator |
| **D3** | 数据源抽象 + Demo 模式 | SensorSource 协议；RingSource 真连；DemoSource 预录回放；双模式一键切换 |
| **D4** | 戒指真连 + 全事件接入 | 真戒指 BLE 全流程；IMU + 按键 + 手势 + 录音全事件监听；模式状态机联调 |
| **D5** | 断连恢复 + 错误处理 | 指数退避重连；异常分类处理；电量监控；本地回退模式验证 |
| **D6** | 预录数据制作 + 算法调参 | 录制整晚睡眠数据 + 专注 session 数据；校准阈值；制作 Demo 回放脚本 |
| **D7** | 联调彩排 | 全链路压测（云+本地各≥3 遍）；Demo 剧本排练；降级开关逐一验证 |

---

## 附录：SDK 接口速查

### 连接与会话

| 函数 | 说明 |
|------|------|
| `scan_rings(mac=None)` | 扫描附近 BLE 戒指设备 |
| `RingSoundClient()` | 创建客户端实例 |
| `client.connect(mac)` | BLE 连接 |
| `client.disconnect()` | 断开连接 |

### IMU 数据

| 函数 | 协议 | 说明 |
|------|------|------|
| `start_sensor_report()` | `0x0601` | 开启 IMU 实时上报 |
| `wait_sensor_data()` | `0x0605` | 等待批量 IMU 数据 |
| `stop_sensor_report()` | `0x0603` | 停止 IMU 上报 |

### 按键事件

| 函数 | 协议 | 说明 |
|------|------|------|
| `wait_sensor_key_single_press_event()` | `0x0704` | 等待单击（拍击） |
| `wait_sensor_key_double_press_event()` | `0x0703` | 等待双击 |

### 手势事件

| 函数 | 协议 | 说明 |
|------|------|------|
| `wait_sensor_gesture_event()` | `0x0702` | 返回 `GestureEvent(type, probability)` |

### 录音

| 函数 | 协议 | 说明 |
|------|------|------|
| `receive_auto_audio_file()` | `0x0505` | 接收自动上报的录音 |
| `save_audio_bundle(data, prefix)` | — | 保存原始录音为 .bin + .wav |
| `decode_audio_to_wav(data)` | — | Speex 解码为 WAV |

### 系统

| 函数 | 协议 | 说明 |
|------|------|------|
| `get_system_info()` | `0x0101/0x0102` | 固件版本、电量、SN、时间 |
| `enable_time_sync()` | `0x0401/0x0402` | 自动校时 |

### 手势事件类型

```python
@dataclass
class GestureEvent:
    type: int       # 1=wave, 2=rotate_front, 3=rotate_back（待 SDK 确认）
    probability: float
```

---

*镜园 FlowGarden · 戒指桥接与感知 PRD v1.0 · 2026-07-23*

*本文档供硬件/嵌入式工程师和 Python 后端工程师直接使用。云端对接见《后端与云端 PRD v1.0》，前端对接见《前端画风设计指南 v1.1》和总 PRD v3.0 第 7 章。*
