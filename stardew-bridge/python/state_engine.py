"""分身农庄 - 状态引擎 (P2)

维护现实状态机：focus / rest / distracted / sleep，
输出当前状态 + 效率因子 efficiency ∈ [0,1]。
"""
import time
import asyncio
from dataclasses import dataclass, field
from typing import Optional
from loguru import logger

from config import config
from event_bus import event_bus, FarmEvent


@dataclass
class RealityState:
    """现实状态快照"""
    mode: str = "rest"              # focus | rest | distracted | sleep
    focus_start_ts: float = 0.0
    focus_duration_sec: float = 0.0
    total_focus_today_sec: float = 0.0
    streak_days: int = 0
    distraction_count: int = 0
    last_activity_ts: float = field(default_factory=time.time)
    efficiency: float = 0.5         # [0,1]

    def reset_focus(self):
        self.mode = "rest"
        self.focus_start_ts = 0.0
        self.focus_duration_sec = 0.0


class StateEngine:
    """四态状态机 + 效率计算"""

    def __init__(self):
        self.state = RealityState()
        self._tick_task: Optional[asyncio.Task] = None

    async def start(self):
        # 订阅事件
        event_bus.subscribe("double_tap", self._on_double_tap)
        event_bus.subscribe("tick", self._on_tick)

        # 定时 tick
        self._tick_task = asyncio.create_task(self._tick_loop())
        logger.info("状态引擎已启动")

    async def stop(self):
        if self._tick_task:
            self._tick_task.cancel()

    async def _on_double_tap(self, event: FarmEvent):
        """双击切换专注/休息"""
        if self.state.mode in ("focus", "distracted"):
            # 结束专注
            self.state.total_focus_today_sec += self.state.focus_duration_sec
            self.state.mode = "rest"
            logger.info(f"专注结束: 本次 {self.state.focus_duration_sec:.0f}s, "
                       f"今日累计 {self.state.total_focus_today_sec:.0f}s")
            await event_bus.publish(FarmEvent(
                type="rest",
                data={"duration": self.state.focus_duration_sec}
            ))
            self.state.reset_focus()
        else:
            # 开始专注
            self.state.mode = "focus"
            self.state.focus_start_ts = time.time()
            self.state.focus_duration_sec = 0.0
            self.state.distraction_count = 0
            logger.info("专注开始")
            await event_bus.publish(FarmEvent(type="focus_start", data={}))

    async def _on_tick(self, event: FarmEvent):
        """定时更新状态与效率"""
        now = time.time()

        # 睡眠检测
        hour = time.localtime(now).tm_hour
        if (hour >= config.sleep_window_start or hour < config.sleep_window_end):
            if self.state.mode != "sleep":
                self.state.mode = "sleep"
                await event_bus.publish(FarmEvent(type="sleep", data={}))
                return

        # 专注中：检查是否分心
        if self.state.mode == "focus":
            self.state.focus_duration_sec = now - self.state.focus_start_ts
            idle = now - self.state.last_activity_ts
            if idle > config.focus_timeout_sec:
                self.state.mode = "distracted"
                self.state.distraction_count += 1
                await event_bus.publish(FarmEvent(
                    type="distracted",
                    data={"idle_sec": idle, "distraction_count": self.state.distraction_count}
                ))
                return

        # 效率计算
        self.state.efficiency = self._calc_efficiency()
        self.state.last_activity_ts = now

    def _calc_efficiency(self) -> float:
        """效率 ∈ [0,1] = f(专注时长, streak)"""
        if self.state.mode == "focus":
            base = min(self.state.focus_duration_sec / 3600, 1.0)  # 1h→1.0
            streak_bonus = min(self.state.streak_days / 7, 1.0) * config.streak_max_bonus
            return min(base + streak_bonus, 1.0)
        elif self.state.mode == "distracted":
            return 0.1
        elif self.state.mode == "sleep":
            return 0.0
        else:
            return 0.5

    async def _tick_loop(self):
        """每 15s 触发 tick"""
        while True:
            await asyncio.sleep(config.farm_tick_interval_sec)
            await event_bus.publish(FarmEvent(type="tick", data={
                "efficiency": self.state.efficiency,
                "mode": self.state.mode,
            }))


# 全局单例
state_engine = StateEngine()
