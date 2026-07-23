"""分身农庄 - 配置管理

所有可调参数集中于此，环境变量覆盖默认值。
"""
import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Config:
    # === 戒指 ===
    ring_mac: str = os.getenv("RING_MAC", "F1:C1:8A:35:40:FB")
    scan_timeout: float = 10.0
    reconnect_max: int = 5
    reconnect_backoff_base: float = 1.0

    # === 状态引擎 ===
    focus_timeout_sec: int = 300          # 专注超时（5分钟无操作→分心）
    distracted_threshold_sec: int = 180   # 分心累计阈值（触发负面后果）
    sleep_window_start: int = 22          # 睡眠窗口开始（22:00）
    sleep_window_end: int = 7             # 睡眠窗口结束（07:00）
    focus_boost_per_min: float = 0.002    # 每分钟专注增加的效率
    streak_max_bonus: float = 0.3         # 连续天数最大加成

    # === 映射 ===
    farm_tick_interval_sec: int = 15      # 状态检查间隔
    idle_action_interval_sec: int = 60    # 空闲时最低动作间隔

    # === LLM ===
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "claude-sonnet-4-20250514")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "https://api.anthropic.com")
    llm_max_tokens: int = 1024
    llm_temperature: float = 0.7

    # === STT ===
    stt_api_key: str = os.getenv("STT_API_KEY", "")
    stt_model: str = os.getenv("STT_MODEL", "whisper-1")

    # === MCP ===
    mcp_command: str = "node"
    mcp_args: list = field(default_factory=lambda: [
        "vendor/mcp-server/build/index.js"
    ])
    stardew_bridge_path: str = os.getenv(
        "STARDEW_BRIDGE_PATH",
        r"C:\Program Files (x86)\Steam\steamapps\common\Stardew Valley\Mods\StardewMCPBridge"
    )
    stardew_action_dir: str = os.getenv(
        "STARDEW_ACTION_DIR",
        r"C:\Program Files (x86)\Steam\steamapps\common\Stardew Valley\Mods\StardewMCPBridge\actions"
    )

    # === WebSocket ===
    ws_host: str = "localhost"
    ws_port: int = 8765

    # === TTS ===
    tts_enabled: bool = True
    tts_lang: str = "zh-CN"
    tts_rate: float = 1.0

    # === 演示兜底 ===
    demo_mode: bool = os.getenv("DEMO_MODE", "0") == "1"

    # === 日志 ===
    log_level: str = os.getenv("LOG_LEVEL", "INFO")


config = Config()
