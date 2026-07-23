# 工具清单与 P0 实测报告：StardewValley-MCP 中间层

> P0「基座打通」交付物 · 生成于 2026-07-23
> 基座：fork `amarisaster/StardewValley-MCP` v0.3.0（MIT），HEAD `6cb2ffa`
> 实测环境：SMAPI 4.5.2 + Stardew Valley 1.6.15 build 24356 + Windows 11

---

## 1. 环境与部署（已完成）

| 项 | 结果 |
| --- | --- |
| git / node v24 / npm v11 / dotnet 9 | ✅ 就绪 |
| MCP Server 构建（`vendor/mcp-server`，tsc） | ✅ `build/index.js`，25 工具 |
| SMAPI MOD 构建（net6.0 + ModBuildConfig） | ✅ 0 警告 0 错误 |
| MOD 部署到游戏 Mods | ✅ 含仓库自带 companion 贴图 |
| 游戏路径 | `C:\Program Files (x86)\Steam\steamapps\common\Stardew Valley` |
| MOD 加载 | ✅ SMAPI 日志：`Stardew MCP Bridge 0.3.0 ... Bridge online` |

## 2. 通信机制（实测确认）

- **读**：MOD 每 tick 把游戏状态写入 `Mods\StardewMCPBridge\bridge_data.json`（原子写）。
- **写**：命令以单文件投入 `Mods\StardewMCPBridge\actions\`，文件名 `<unixMs>-<seq>.json`，MOD 按文件名序读取、**读后即删**（一次性消费、无重复执行）。
- **动作格式**：`{"actionType":"<名>", <顶层参数...>}`；仅 `chat` 用 `metadata.message`。
- MCP Server 经环境变量 `STARDEW_BRIDGE_PATH` / `STARDEW_ACTION_DIR` 指向该 mod 目录。
- 本项目验证方式：Python/PowerShell 直接读写这两处即可驱动，**无需 LLM**（辅助脚本 `python/_send.ps1`）。

## 3. 实测结果（5 项核心通路，全部通过）

| 动作 | 发送内容 | 结果 | 结论 |
| --- | --- | --- | --- |
| 读状态 | 读 `bridge_data.json` | 得到 time/day/season/weather/location/player(money=500,stamina) | ✅ 读通路 |
| `spawn` | `{"actionType":"spawn"}` | Companion1/2 出现在 Farm，follow 模式，stamina 100% | ✅ shadow farmer 生成 |
| `farm` | `{"actionType":"farm"}` | 两 companion → `mode:farm`，`status:"farm: heading to (18,83)"`，自主寻路移动 | ✅ 自主农场模式 + 寻路 |
| `set_mode`→player | `{"actionType":"set_mode","target":"Companion1","mode":"player"}` | Companion1 → `mode:player`，`status:"awaiting command"`，附带 `surroundings`（可通行/水面/作物/物体） | ✅ 直控模式 + "眼睛" |
| `move_to` | `{"actionType":"move_to","companion":"Companion1","x":52,"y":68}` | `lastCommandResult:{action:"move_to",success:true,detail:"Pathing to (52,68)"}` | ✅ 直控移动 + 结果反馈 |

**关键结论**：
1. 完整闭环 `动作文件 → MOD → shadow farmer → 状态回写` 打通，1.6.15 兼容。
2. **自主 farm 模式可用** → 直接支撑「专注→高效种地」映射，无需 LLM 逐帧驱动。
3. **player 模式带 surroundings + lastCommandResult** → 支撑语音精确指令与编排层的执行确认。
4. shadow farmer 寻路正常（能跨地图移动）。

## 4. 完整工具清单（25 个）

> 状态：✅=本次实测通过；○=源码确认可用、未逐一实测（P1+ 按需验证）

### 4.1 全局工具（13）
| # | 工具 | 动作 JSON | 必填 | 状态 | 对本项目用途 |
| --- | --- | --- | --- | --- | --- |
| 1 | `get_state` | 读 bridge_data.json | — | ✅ | 反馈层回读金币/体力/时间/天气 |
| 2 | `spawn` | `{spawn}` | — | ✅ | 会话开始生成分身 |
| 3 | `follow` | `{follow}` | — | ○ | rest 态跟随/待命 |
| 4 | `stay` | `{stay}` | — | ○ | idle/safe-idle |
| 5 | `farm` | `{farm}` | — | ✅ | **focus 高效：自动浇水/收割/清杂** |
| 6 | `mine` | `{mine}` | — | ○ | focus 变体：采矿/战斗 |
| 7 | `fish` | `{fish}` | — | ○ | 语音"去钓鱼" |
| 8 | `water_all` | `{water_all}` | — | ○ | 一键浇水（高效映射，省往返） |
| 9 | `harvest_all` | `{harvest_all}` | — | ○ | 一键收割（高效映射） |
| 10 | `chat` | `{chat, metadata:{message}}` | message | ○ | 游戏内提示/叙事 |
| 11 | `warp` | `{warp, location, x, y}` | location,x,y | ○ | 全体传送 |
| 12 | `set_mode` | `{set_mode, target, mode}` | target,mode | ✅ | 切自主/player；模式：follow/farm/mine/fish/idle/player |
| 13 | `action` | `{action?, x?, y?}` 自定义 water/harvest/clear/hoe | actionType | ○ | 单格精细操作 |

### 4.2 Player 模式工具（12，需先 set_mode=player）
| # | 工具 | 动作 JSON | 必填 | 状态 | 对本项目用途 |
| --- | --- | --- | --- | --- | --- |
| 14 | `get_surroundings` | 从 bridge_data.json 提取 | companion | ✅（随 player 模式出现） | LLM 的"眼睛" |
| 15 | `get_inventory` | 从 bridge_data.json 提取 | companion | ○ | 决策前查背包 |
| 16 | `get_companion_state` | 从 bridge_data.json 提取 | companion | ○ | 完整分身状态 |
| 17 | `move_to` | `{move_to, companion, x, y}` | companion,x,y | ✅ | 寻路移动 |
| 18 | `warp_companion` | `{warp_to, companion, location, x, y}` | companion,location,x,y | ○ | 单体传送 |
| 19 | `face_direction` | `{face_direction, companion, direction}` | companion,direction | ○ | 转向 |
| 20 | `use_tool` | `{use_tool, companion, tool, x, y}` | companion,tool,x,y | ○ | 镐/斧/锄/壶/剑 |
| 21 | `interact` | `{interact, companion, x, y}` | companion,x,y | ○ | 交互物体/作物/箱子/NPC |
| 22 | `attack` | `{attack, companion}` | companion | ○ | 攻击最近怪物 |
| 23 | `cast_fishing_rod` | `{cast_fishing_rod, companion}` | companion | ○ | 抛竿+自动咬钩 |
| 24 | `set_auto_combat` | `{set_auto_combat, companion, enabled}` | companion,enabled | ○ | 实时战斗（LLM 往返太慢时用） |
| 25 | `eat_item` | `{eat_item, companion, slot?}` | companion | ○ | 吃食物回体力 |

## 5. 对后续里程碑的输入

- **P2 映射层**：优先用 `farm`/`mine`/`fish` 自主模式 + `water_all`/`harvest_all` 一键工具承载「专注高效」，把 LLM 从高频动作中解放；player 模式 + 单格工具留给语音精确指令。
- **P3 编排层**：读 `lastCommandResult.success/detail` 确认工具执行；player 模式的 `surroundings` 作为 LLM 视野输入。
- **性能红线**：仓库自带 `set_auto_combat` 就是因「LLM 往返太慢」，印证**高频动作不走 LLM 逐帧**的设计前提。

## 6. 当前游戏内状态（实测遗留）
- Companion1：player 模式（曾 move_to）；Companion2：farm 模式（Town 内）。
- 如需复位：发送 `follow` 或 `stay`（全体），或 `set_mode target=Companion1 mode=follow`。

## 7. 复现实测命令（辅助脚本 `python/_send.ps1`）
```
powershell -File python\_send.ps1 -Action spawn
powershell -File python\_send.ps1 -Action farm
powershell -File python\_send.ps1 -Action set_mode -Target Companion1 -Mode player
powershell -File python\_send.ps1 -Action move_to -Companion Companion1 -X 52 -Y 68
```
读状态：直接查看 `Mods\StardewMCPBridge\bridge_data.json`。
