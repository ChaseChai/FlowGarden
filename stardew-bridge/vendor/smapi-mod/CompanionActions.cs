using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.TerrainFeatures;
using StardewValley.Objects;
using SObject = StardewValley.Object;

namespace StardewMCPBridge
{
    /// <summary>
    /// Direct game-object manipulation for farm actions.
    /// No Farmer instance needed — we interact with tiles directly.
    /// </summary>
    public static class CompanionActions
    {
        /// <summary>Water a crop at the given tile.</summary>
        public static bool WaterTile(GameLocation location, Vector2 tile, IMonitor monitor)
        {
            if (location.terrainFeatures.TryGetValue(tile, out var feature) && feature is HoeDirt dirt)
            {
                if (dirt.state.Value != 1) // not already watered
                {
                    dirt.state.Value = 1;
                    location.temporarySprites.Add(new TemporaryAnimatedSprite(
                        "TileSheets\\animations", new Rectangle(0, 0, 64, 64),
                        50f, 9, 1, tile * 64f, false, false, 0.01f, 0.01f,
                        Color.White, 1f, 0f, 0f, 0f
                    ));
                    monitor.Log($"Watered tile at ({tile.X}, {tile.Y})", LogLevel.Trace);
                    return true;
                }
            }
            return false;
        }

        /// <summary>Harvest a ready crop at the given tile.</summary>
        public static bool HarvestTile(GameLocation location, Vector2 tile, IMonitor monitor)
        {
            if (location.terrainFeatures.TryGetValue(tile, out var feature) && feature is HoeDirt dirt)
            {
                if (dirt.crop != null && dirt.readyForHarvest())
                {
                    bool success = dirt.crop.harvest((int)tile.X, (int)tile.Y, dirt, null);
                    if (success)
                    {
                        monitor.Log($"Harvested crop at ({tile.X}, {tile.Y})", LogLevel.Trace);
                        return true;
                    }
                }
            }
            return false;
        }

        /// <summary>Clear a debris object (stone, weed, twig) at the given tile.</summary>
        public static bool ClearDebris(GameLocation location, Vector2 tile, IMonitor monitor)
        {
            if (location.objects.TryGetValue(tile, out var obj))
            {
                string name = obj.Name ?? "";
                // Stone, Weeds, Twigs
                if (name.Contains("Stone") || name.Contains("Weed") || name.Contains("Twig")
                    || obj.ParentSheetIndex == 294 || obj.ParentSheetIndex == 295
                    || obj.ParentSheetIndex == 343 || obj.ParentSheetIndex == 450)
                {
                    obj.performRemoveAction();
                    location.objects.Remove(tile);
                    monitor.Log($"Cleared debris at ({tile.X}, {tile.Y}): {name}", LogLevel.Trace);
                    return true;
                }
            }
            return false;
        }

        /// <summary>Find a seed item in the player's inventory (category -74 = Seeds). Optional name filter.</summary>
        public static SObject FindSeed(string seedName = null)
        {
            var seeds = Game1.player.Items.OfType<SObject>().Where(o => o.Category == -74);
            if (string.IsNullOrEmpty(seedName))
                return seeds.FirstOrDefault();
            return seeds.FirstOrDefault(o => o.Name != null
                && o.Name.IndexOf(seedName, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        /// <summary>Plant a seed from the player's inventory onto tilled, unplanted dirt.
        /// Uses the vanilla placement path (Object.placementAction), so the game itself
        /// validates season/location and we consume the item only on success.</summary>
        public static bool PlantTile(GameLocation location, Vector2 tile, IMonitor monitor, string seedName = null)
        {
            if (!(location.terrainFeatures.TryGetValue(tile, out var feature) && feature is HoeDirt dirt))
                return false;
            if (dirt.crop != null)
                return false; // already planted

            SObject seed = FindSeed(seedName);
            if (seed == null)
            {
                monitor.Log("PlantTile: no matching seeds in inventory", LogLevel.Trace);
                return false;
            }

            Game1.player.ActiveItem = seed;
            bool ok = seed.placementAction(location, (int)tile.X * 64, (int)tile.Y * 64, Game1.player);
            if (ok)
            {
                Game1.player.reduceActiveItemByOne();
                monitor.Log($"Planted {seed.Name} at ({tile.X}, {tile.Y})", LogLevel.Trace);
            }
            return ok;
        }

        /// <summary>Hoe the ground at the given tile to create farmable dirt.</summary>
        public static bool HoeTile(GameLocation location, Vector2 tile, IMonitor monitor)
        {
            if (!location.terrainFeatures.ContainsKey(tile)
                && !location.objects.ContainsKey(tile)
                && location.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") != null)
            {
                location.terrainFeatures.Add(tile, new HoeDirt(0, location));
                monitor.Log($"Hoed tile at ({tile.X}, {tile.Y})", LogLevel.Trace);
                return true;
            }
            return false;
        }

        /// <summary>Scan a location for tiles that need work and return a prioritized task list.</summary>
        public static List<FarmTask> ScanForTasks(GameLocation location, IMonitor monitor, Vector2? nearTile = null, int hoeRadius = 12)
        {
            var tasks = new List<FarmTask>();
            bool hasSeeds = FindSeed() != null;

            foreach (var pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt dirt)
                {
                    // Harvest-ready crops (highest priority)
                    if (dirt.crop != null && dirt.readyForHarvest())
                    {
                        tasks.Add(new FarmTask
                        {
                            Type = FarmTaskType.Harvest,
                            Tile = pair.Key,
                            Priority = 10
                        });
                    }
                    // Unwatered crops
                    else if (dirt.crop != null && dirt.state.Value != 1 && !Game1.isRaining)
                    {
                        tasks.Add(new FarmTask
                        {
                            Type = FarmTaskType.Water,
                            Tile = pair.Key,
                            Priority = 8
                        });
                    }
                    // Empty tilled dirt → plant if we carry seeds
                    else if (dirt.crop == null && hasSeeds)
                    {
                        tasks.Add(new FarmTask
                        {
                            Type = FarmTaskType.Plant,
                            Tile = pair.Key,
                            Priority = 7
                        });
                    }
                }
            }

            // Debris on the farm
            foreach (var pair in location.objects.Pairs)
            {
                var obj = pair.Value;
                string name = obj.Name ?? "";
                if (name.Contains("Stone") || name.Contains("Weed") || name.Contains("Twig")
                    || obj.ParentSheetIndex == 294 || obj.ParentSheetIndex == 295
                    || obj.ParentSheetIndex == 343 || obj.ParentSheetIndex == 450)
                {
                    tasks.Add(new FarmTask
                    {
                        Type = FarmTaskType.ClearDebris,
                        Tile = pair.Key,
                        Priority = 3
                    });
                }
            }

            // Tillable open ground near the player (bounded so we don't churn the whole map).
            if (nearTile.HasValue)
            {
                int added = 0;
                int cx = (int)nearTile.Value.X;
                int cy = (int)nearTile.Value.Y;
                for (int x = cx - hoeRadius; x <= cx + hoeRadius && added < 20; x++)
                {
                    for (int y = cy - hoeRadius; y <= cy + hoeRadius && added < 20; y++)
                    {
                        var t = new Vector2(x, y);
                        if (location.terrainFeatures.ContainsKey(t) || location.objects.ContainsKey(t))
                            continue;
                        if (location.doesTileHaveProperty(x, y, "Diggable", "Back") == null)
                            continue;
                        if (!location.isTilePassable(new xTile.Dimensions.Location(x, y), Game1.viewport))
                            continue;
                        tasks.Add(new FarmTask
                        {
                            Type = FarmTaskType.Hoe,
                            Tile = t,
                            Priority = 2
                        });
                        added++;
                    }
                }
            }

            // Sort by priority descending, then distance to center
            tasks.Sort((a, b) => b.Priority.CompareTo(a.Priority));
            return tasks;
        }

        /// <summary>Execute a task at a tile.</summary>
        public static bool ExecuteTask(FarmTask task, GameLocation location, IMonitor monitor)
        {
            switch (task.Type)
            {
                case FarmTaskType.Water:
                    return WaterTile(location, task.Tile, monitor);
                case FarmTaskType.Harvest:
                    return HarvestTile(location, task.Tile, monitor);
                case FarmTaskType.ClearDebris:
                    return ClearDebris(location, task.Tile, monitor);
                case FarmTaskType.Hoe:
                    return HoeTile(location, task.Tile, monitor);
                case FarmTaskType.Plant:
                    return PlantTile(location, task.Tile, monitor);
                default:
                    return false;
            }
        }
    }

    public enum FarmTaskType
    {
        Water,
        Harvest,
        Hoe,
        ClearDebris,
        Plant,
        ToolUse,
        Interact
    }

    public class FarmTask
    {
        public FarmTaskType Type { get; set; }
        public Vector2 Tile { get; set; }
        public int Priority { get; set; }
        public string ToolTypeName { get; set; }  // for manual player_use_tool tasks
        public string SeedName { get; set; }      // for manual player_plant tasks
    }
}
