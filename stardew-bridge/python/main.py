"""分身农庄 - 主入口

启动全链路：戒指桥接 + 状态引擎 + 编排器 + 反馈。
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "python"))

from loguru import logger

# 配置日志
logger.remove()
logger.add(
    sys.stderr,
    format="<green>{time:HH:mm:ss}</green> | <level>{level: <7}</level> | <level>{message}</level>",
    level="INFO"
)
logger.add("farm_log_{time:YYYY-MM-DD}.log", rotation="10 MB", level="DEBUG")

from config import config
from event_bus import event_bus, FarmEvent
from ring_bridge import RingBridge
from state_engine import state_engine
from orchestrator import orchestrator
from feedback import feedback


async def demo_loop():
    """演示兜底：无戒指时模拟事件序列"""
    logger.info("🎮 DEMO 模式：模拟事件序列")

    # 模拟一天
    await asyncio.sleep(2)
    await event_bus.publish(FarmEvent(type="double_tap"))  # 开始专注
    await asyncio.sleep(10)
    await event_bus.publish(FarmEvent(type="double_tap"))  # 结束专注
    await asyncio.sleep(5)
    await event_bus.publish(FarmEvent(type="double_tap"))  # 再次专注
    await asyncio.sleep(5)
    await event_bus.publish(FarmEvent(type="double_tap"))  # 提前结束（模拟分心）
    logger.info("🎮 DEMO 循环结束")


async def main():
    logger.info("=" * 50)
    logger.info("🌾 分身农庄 Avatar Farm 启动中...")
    logger.info(f"   DEMO_MODE = {config.demo_mode}")
    logger.info(f"   戒指 MAC = {config.ring_mac}")
    logger.info("=" * 50)

    # 启动引擎（必须先于 ring bridge）
    await state_engine.start()
    await orchestrator.start()
    await feedback.start()

    if config.demo_mode:
        # Demo 模式：模拟事件
        await demo_loop()
    else:
        # 真戒指模式
        bridge = RingBridge()
        try:
            await bridge.start()
        except KeyboardInterrupt:
            pass
        finally:
            await bridge.stop()

    # 等待一段时间让最后的动作执行完
    await asyncio.sleep(5)

    logger.info("🌾 分身农庄已停止")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("用户中断")
