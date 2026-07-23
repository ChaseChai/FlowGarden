using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;

namespace StardewMCPBridge
{
    /// <summary>
    /// Pilots the real main player (Game1.player) — human-style.
    ///
    /// Technical route (migrated from direct API calls to INPUT SIMULATION, inspired by
    /// Hunter-Thompson/stardew-mcp): every action flows through the game's native input
    /// pipeline, exactly as if a human were at the keyboard/mouse:
    ///   - Movement: own A* (Pathfinder) + one simulated direction-key press per tick.
    ///     Real walking: native speed, collision, animation. No teleports, no controller hacks.
    ///   - Tool swings (hoe/watering can/pickaxe/axe/scythe/sword): select the tool in the
    ///     hotbar, face the tile, aim the cursor, press the use-tool button. The game applies
    ///     its own rules (reach, stamina, swing timing, watering-can water level...).
    ///   - Harvest / interact: face the tile, press the action button → vanilla
    ///     GameLocation.checkAction → HoeDirt.performUseAction etc.
    ///   - Planting: select the seed stack, aim, press the use-tool button; a delayed verify
    ///     falls back to the vanilla placement path (Object.placementAction) if needed.
    ///   - Sleep: the vanilla bed dialog answer (answerDialogueAction "Sleep_Yes").
    /// </summary>
    public class PlayerPilot
    {
        public enum PilotMode { Idle, Manual, Farm }

        private const int MaxRecalcAttempts = 5;   // path recalculations before giving up
        private const int StuckLimitTicks = 120;   // ~2s without tile progress = stuck
        private const int BlockedLimitTicks = 600; // ~10s unable to move (menu/fade) = fail
        private const int MaxTaskAttempts = 5;     // per-tile attempts before skipping it
        private const int ToolRepeatCooldownTicks = 20;  // ~0.33s between chained swings
        private const int FarmQueueMaxAgeTicks = 1800;   // rescan farm tasks every ~30s

        private readonly IMonitor monitor;
        private readonly IInputHelper input;
        private readonly Pathfinder pathfinder = new Pathfinder();

        public PilotMode Mode { get; private set; } = PilotMode.Idle;

        // ---- movement state ----
        private List<Vector2> path;
        private int pathIndex;
        private Vector2? finalTarget;
        private int stuckTicks;
        private Vector2 lastTile;
        private int recalcAttempts;
        private int blockedTicks;

        // ---- task state ----
        private bool executeOnArrive;   // run currentTask when the path completes
        private FarmTask currentTask;   // task to execute on arrival (type drives behavior)
        private int actionCooldown;
        private readonly Dictionary<Vector2, int> taskAttempts = new Dictionary<Vector2, int>();
        private string attemptsLocation;

        // ---- deferred work ----
        private bool pendingSleep;          // warped home; sleep once the fade settles
        private Vector2? plantVerifyTile;   // verify an input-simulated planting
        private int plantVerifyTicks;
        private string plantSeedName;

        // ---- chained tool use (player_use_tool_repeat) ----
        private int toolRepeatRemaining;
        private int toolRepeatCooldown;

        // ---- farm task queue (nearest-neighbor chaining, P3) ----
        private List<FarmTask> farmQueue;
        private int farmQueueAge;

        private object lastResult;

        public PlayerPilot(IMonitor monitor, IInputHelper input)
        {
            this.monitor = monitor;
            this.input = input;
        }

        // ======================
        // TICK (every frame)
        // ======================

        public void Tick()
        {
            if (!Context.IsWorldReady || Game1.player == null) return;

            // Deferred sleep: after warping home the world fades; wait until the player is
            // free to move (fade done, no menu) inside the farmhouse, then end the day.
            if (this.pendingSleep)
            {
                if (Game1.currentLocation is FarmHouse && Context.CanPlayerMove)
                    this.TrySleep();
                return;
            }

            // Chained tool swings (player_use_tool_repeat): stand and swing until done.
            if (this.toolRepeatRemaining > 0)
            {
                this.ProcessToolRepeat();
                return;
            }

            // Deferred plant verification (input-sim first, vanilla fallback).
            if (this.plantVerifyTile.HasValue)
                this.VerifyPlant();

            // Movement in progress → walk one step (simulated key press) per tick.
            if (this.path != null)
            {
                this.ProcessMovement();
                return;
            }

            if (this.actionCooldown > 0) { this.actionCooldown--; return; }

            if (this.Mode == PilotMode.Farm)
                this.DoFarm();
        }

        // ======================
        // MOVEMENT (A* + simulated direction keys)
        // ======================

        /// <summary>Compute an A* path and start walking. Returns false if unreachable.</summary>
        private bool StartPath(int tx, int ty)
        {
            var loc = Game1.player.currentLocation;
            var goal = new Vector2(tx, ty);
            var found = this.pathfinder.FindPath(loc, Game1.player.Tile, goal);
            if (found == null)
                return false;

            this.ClearMovement();
            if (found.Count == 0)
            {
                // Already standing on the goal tile.
                this.ArriveAtTarget();
                return true;
            }

            this.path = found;
            this.pathIndex = 0;
            this.finalTarget = goal;
            this.lastTile = Game1.player.Tile;
            return true;
        }

        private void ProcessMovement()
        {
            var player = Game1.player;

            // Menus / fade transitions / tool animations: wait without failing.
            if (!Context.CanPlayerMove || player.UsingTool)
            {
                this.blockedTicks++;
                if (this.blockedTicks > BlockedLimitTicks)
                    this.FailMovement("blocked too long (menu/fade)");
                return;
            }
            this.blockedTicks = 0;

            var currentTile = player.Tile;
            var waypoint = this.path[this.pathIndex];

            if (currentTile == waypoint)
            {
                this.pathIndex++;
                this.stuckTicks = 0;
                if (this.pathIndex >= this.path.Count)
                {
                    this.ArriveAtTarget();
                    return;
                }
                waypoint = this.path[this.pathIndex];
            }

            // Stuck detection at tile granularity.
            if (currentTile == this.lastTile) this.stuckTicks++;
            else { this.stuckTicks = 0; this.lastTile = currentTile; }

            if (this.stuckTicks > StuckLimitTicks)
            {
                this.recalcAttempts++;
                if (this.recalcAttempts >= MaxRecalcAttempts)
                {
                    this.FailMovement($"stuck at ({(int)currentTile.X},{(int)currentTile.Y}) after {MaxRecalcAttempts} path recalculations");
                    return;
                }
                this.monitor.Log($"Movement stuck; recalculating path ({this.recalcAttempts}/{MaxRecalcAttempts})", LogLevel.Debug);
                if (!this.RecalculatePath())
                    this.FailMovement("path blocked - cannot reach destination");
                return;
            }

            // Press the direction key toward the next waypoint (axis-aligned path).
            int dx = (int)waypoint.X - (int)currentTile.X;
            int dy = (int)waypoint.Y - (int)currentTile.Y;
            if (dx != 0 || dy != 0)
                this.input.Press(this.GetMoveButton(dx, dy));
        }

        private bool RecalculatePath()
        {
            if (!this.finalTarget.HasValue) return false;
            var found = this.pathfinder.FindPath(Game1.player.currentLocation, Game1.player.Tile, this.finalTarget.Value);
            if (found == null) return false;
            this.path = found;
            this.pathIndex = 0;
            this.stuckTicks = 0;
            this.lastTile = Game1.player.Tile;
            return true;
        }

        private void FailMovement(string reason)
        {
            this.monitor.Log($"Movement failed: {reason}", LogLevel.Warn);
            this.ClearMovement();
            this.executeOnArrive = false;
            this.currentTask = null;
            Game1.player.Halt();
            this.lastResult = new { action = "move", success = false, detail = reason };
            this.actionCooldown = 15;
        }

        private void ClearMovement()
        {
            this.path = null;
            this.pathIndex = 0;
            this.finalTarget = null;
            this.stuckTicks = 0;
            this.recalcAttempts = 0;
            this.blockedTicks = 0;
        }

        private void ArriveAtTarget()
        {
            Game1.player.Halt();
            var task = this.currentTask;
            bool doTask = this.executeOnArrive;
            this.ClearMovement();
            this.executeOnArrive = false;
            this.currentTask = null;

            if (doTask && task != null)
            {
                this.ExecuteFarmAction(Game1.player.currentLocation, task);
                return; // ExecuteFarmAction sets its own cooldown
            }

            this.lastResult = new { action = "move", success = true, detail = $"arrived at ({(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y})" };
        }

        private SButton GetMoveButton(int dx, int dy)
        {
            var o = Game1.options;
            if (dx > 0) return o.moveRightButton.Length > 0 ? o.moveRightButton[0].ToSButton() : SButton.D;
            if (dx < 0) return o.moveLeftButton.Length > 0 ? o.moveLeftButton[0].ToSButton() : SButton.A;
            if (dy > 0) return o.moveDownButton.Length > 0 ? o.moveDownButton[0].ToSButton() : SButton.S;
            return o.moveUpButton.Length > 0 ? o.moveUpButton[0].ToSButton() : SButton.W;
        }

        // ======================
        // INPUT SIMULATION primitives
        // ======================

        /// <summary>Face a (usually adjacent) tile, like a human turning toward it.</summary>
        private void FaceTile(Vector2 tile)
        {
            var p = Game1.player.Tile;
            float dx = tile.X - p.X, dy = tile.Y - p.Y;
            Game1.player.faceDirection(Math.Abs(dx) > Math.Abs(dy)
                ? (dx > 0 ? 1 : 3)
                : (dy > 0 ? 2 : 0));
        }

        /// <summary>Aim the game cursor at the faced tile (keyboard-style targeting).</summary>
        private void SetCursorToFacingTile()
        {
            var player = Game1.player;
            int tileX = (int)player.Tile.X;
            int tileY = (int)player.Tile.Y;
            switch (player.FacingDirection) // 0 up, 1 right, 2 down, 3 left
            {
                case 0: tileY--; break;
                case 1: tileX++; break;
                case 2: tileY++; break;
                case 3: tileX--; break;
            }

            Game1.currentCursorTile = new Vector2(tileX, tileY);
            Game1.lastCursorMotionWasMouse = false; // game uses facing/cursor tile, not the OS mouse

            int screenX = (tileX * 64 + 32) - Game1.viewport.X;
            int screenY = (tileY * 64 + 32) - Game1.viewport.Y;
            Game1.setMousePosition(screenX, screenY); // visual feedback only
        }

        /// <summary>Press the use-tool button (left click equivalent) aimed at the faced tile.</summary>
        private void PressUseTool()
        {
            this.SetCursorToFacingTile();
            var b = Game1.options.useToolButton.Length > 0
                ? Game1.options.useToolButton[0].ToSButton()
                : SButton.MouseLeft;
            this.input.Press(b);
        }

        /// <summary>Press the action/check button (right click equivalent) aimed at the faced tile.</summary>
        private void PressActionButton()
        {
            this.SetCursorToFacingTile();
            var b = Game1.options.actionButton.Length > 0
                ? Game1.options.actionButton[0].ToSButton()
                : SButton.MouseRight;
            this.input.Press(b);
        }

        /// <summary>Find a hotbar slot (first 12 items) matching a predicate, or -1.</summary>
        private int FindSlot(Func<Item, bool> predicate)
        {
            var items = Game1.player.Items;
            int max = Math.Min(12, items.Count); // CurrentToolIndex only addresses the hotbar
            for (int i = 0; i < max; i++)
            {
                if (items[i] != null && predicate(items[i]))
                    return i;
            }
            return -1;
        }

        private bool SelectSlot(Func<Item, bool> predicate)
        {
            int idx = this.FindSlot(predicate);
            if (idx < 0) return false;
            Game1.player.CurrentToolIndex = idx;
            return true;
        }

        // ======================
        // AUTONOMOUS FARM
        // ======================

        private void DoFarm()
        {
            var loc = Game1.player.currentLocation;
            if (loc == null) return;

            // Attempt budget + task queue reset on location change.
            if (this.attemptsLocation != loc.Name)
            {
                this.taskAttempts.Clear();
                this.attemptsLocation = loc.Name;
                this.farmQueue = null;
            }

            // (Re)scan when there is no queue or it went stale; between rescans we
            // chain task-to-task so the player sweeps the area like a human would,
            // instead of re-sorting the whole map every action (which caused jitter).
            if (this.farmQueue == null)
            {
                this.farmQueue = CompanionActions.ScanForTasks(loc, this.monitor, Game1.player.Tile);
                this.farmQueueAge = 0;
            }
            else if (++this.farmQueueAge > FarmQueueMaxAgeTicks)
            {
                this.farmQueue = null; // force a fresh scan on the next call
                return;
            }

            // Drop tiles that burned their attempt budget.
            this.farmQueue.RemoveAll(t => this.taskAttempts.TryGetValue(t.Tile, out var n) && n >= MaxTaskAttempts);

            if (this.farmQueue.Count == 0)
            {
                this.farmQueue = null;
                this.lastResult = new { mode = "farm", detail = "no tasks in this location" };
                this.actionCooldown = 60;
                return;
            }

            // Nearest-neighbor chaining inside the highest priority group: finish the
            // closest task, then the next-closest of the same priority, and so on.
            var myTile = Game1.player.Tile;
            int topPri = int.MinValue;
            foreach (var t in this.farmQueue)
                if (t.Priority > topPri) topPri = t.Priority;

            FarmTask next = null;
            float bestD = float.MaxValue;
            foreach (var t in this.farmQueue)
            {
                if (t.Priority != topPri) continue;
                float d = Vector2.Distance(myTile, t.Tile);
                if (d < bestD) { bestD = d; next = t; }
            }
            this.farmQueue.Remove(next);

            // Walk to a tile ADJACENT to the task and act from there, exactly like a
            // human - never act on a far tile. Unreachable: burn an attempt, move on.
            var approach = this.FindApproachTile(loc, next.Tile);
            if (approach == null || !this.StartPath((int)approach.Value.X, (int)approach.Value.Y))
            {
                this.taskAttempts[next.Tile] = (this.taskAttempts.TryGetValue(next.Tile, out var m) ? m : 0) + 1;
                this.actionCooldown = 5; // try the next queued task almost immediately
                return;
            }

            this.currentTask = next;
            this.executeOnArrive = true;
        }

        /// <summary>Find a walkable tile to act on the task tile from: prefer an
        /// orthogonally-adjacent tile (stand next to it and face it, like a real player);
        /// for non-occupied tiles (e.g. crop dirt) standing on the tile itself is an
        /// allowed fallback. Returns null if none walkable.</summary>
        private Vector2? FindApproachTile(GameLocation loc, Vector2 taskTile)
        {
            var neighbors = new List<Vector2>
            {
                new Vector2(taskTile.X - 1, taskTile.Y),
                new Vector2(taskTile.X + 1, taskTile.Y),
                new Vector2(taskTile.X, taskTile.Y - 1),
                new Vector2(taskTile.X, taskTile.Y + 1),
            };

            var myTile = Game1.player.Tile;
            Vector2? best = null;
            float bestD = float.MaxValue;
            foreach (var t in neighbors)
            {
                if (!this.pathfinder.IsTileWalkable(loc, (int)t.X, (int)t.Y)) continue;
                float d = Vector2.Distance(myTile, t);
                if (d < bestD) { bestD = d; best = t; }
            }
            if (best != null) return best;

            // Fallback: the task tile itself (only if not occupied by an object).
            if (!loc.objects.ContainsKey(taskTile)
                && this.pathfinder.IsTileWalkable(loc, (int)taskTile.X, (int)taskTile.Y))
                return taskTile;

            return null;
        }

        // ======================
        // TASK EXECUTION (input-simulated)
        // ======================

        private void ExecuteFarmAction(GameLocation loc, FarmTask task)
        {
            Vector2 tile = task.Tile;
            float dist = Vector2.Distance(Game1.player.Tile, tile);

            // Respect the game's reach: only act when actually next to (or on) the tile.
            if (dist > 1.6f)
            {
                this.lastResult = new { action = "farm.skip", success = false, detail = "not adjacent, skipped" };
                this.actionCooldown = 10;
                return;
            }

            // Count attempts per tile so DoFarm eventually skips a tile that won't complete.
            this.taskAttempts[tile] = (this.taskAttempts.TryGetValue(tile, out var n) ? n : 0) + 1;
            string label = task.Type.ToString().ToLower();

            // Standing ON the tile: a button press would hit the FACED tile instead, so use
            // the direct native-logic path for this rare case (same functions vanilla calls).
            if (dist < 0.1f)
            {
                bool okDirect = task.Type switch
                {
                    FarmTaskType.Harvest => CompanionActions.HarvestTile(loc, tile, this.monitor),
                    FarmTaskType.Water => CompanionActions.WaterTile(loc, tile, this.monitor),
                    FarmTaskType.Plant => CompanionActions.PlantTile(loc, tile, this.monitor, task.SeedName),
                    _ => false
                };
                this.lastResult = new { action = $"farm.{label}", success = okDirect, detail = okDirect ? "done (on-tile)" : "failed (on-tile)" };
                this.actionCooldown = 30;
                return;
            }

            this.FaceTile(tile);

            switch (task.Type)
            {
                case FarmTaskType.Harvest:
                    // Right-click the crop: vanilla checkAction → HoeDirt.performUseAction.
                    this.PressActionButton();
                    this.lastResult = new { action = "farm.harvest", success = true, detail = $"harvest click at ({(int)tile.X},{(int)tile.Y})" };
                    this.actionCooldown = 25;
                    break;

                case FarmTaskType.Water:
                    if (!this.SelectSlot(i => i is WateringCan))
                    {
                        this.lastResult = new { action = "farm.water", success = false, detail = "no watering can in hotbar" };
                        this.actionCooldown = 10;
                        return;
                    }
                    this.PressUseTool();
                    this.lastResult = new { action = "farm.water", success = true, detail = $"watering swing at ({(int)tile.X},{(int)tile.Y})" };
                    this.actionCooldown = 50;
                    break;

                case FarmTaskType.ClearDebris:
                {
                    string name = loc.objects.TryGetValue(tile, out var o) ? o.Name ?? "" : "";
                    // 1.6: scythes are MeleeWeapon with isScythe(); weeds cost no energy with a scythe.
                    bool selected = name.Contains("Stone")
                        ? this.SelectSlot(i => i is Pickaxe)
                        : (this.SelectSlot(i => i is MeleeWeapon mw && mw.isScythe()) || this.SelectSlot(i => i is Axe));
                    if (!selected)
                    {
                        this.lastResult = new { action = "farm.clear", success = false, detail = "no suitable tool in hotbar" };
                        this.actionCooldown = 10;
                        return;
                    }
                    this.PressUseTool();
                    this.lastResult = new { action = "farm.clear", success = true, detail = $"tool swing at ({(int)tile.X},{(int)tile.Y}) {name}" };
                    this.actionCooldown = 50;
                    break;
                }

                case FarmTaskType.Hoe:
                    if (!this.SelectSlot(i => i is Hoe))
                    {
                        this.lastResult = new { action = "farm.hoe", success = false, detail = "no hoe in hotbar" };
                        this.actionCooldown = 10;
                        return;
                    }
                    this.PressUseTool();
                    this.lastResult = new { action = "farm.hoe", success = true, detail = $"hoe swing at ({(int)tile.X},{(int)tile.Y})" };
                    this.actionCooldown = 50;
                    break;

                case FarmTaskType.Plant:
                {
                    string seedName = task.SeedName;
                    int slot = this.FindSlot(i => i.Category == -74
                        && (seedName == null || i.Name.IndexOf(seedName, StringComparison.OrdinalIgnoreCase) >= 0));
                    if (slot < 0)
                    {
                        this.lastResult = new { action = "farm.plant", success = false, detail = "no matching seeds in hotbar" };
                        this.actionCooldown = 10;
                        return;
                    }
                    Game1.player.CurrentToolIndex = slot;
                    this.PressUseTool();
                    // Verify shortly; if the click didn't take, fall back to placementAction.
                    this.plantVerifyTile = tile;
                    this.plantVerifyTicks = 50;
                    this.plantSeedName = seedName;
                    this.lastResult = new { action = "farm.plant", success = true, detail = $"planting click at ({(int)tile.X},{(int)tile.Y})" };
                    this.actionCooldown = 55;
                    break;
                }

                case FarmTaskType.ToolUse:
                {
                    bool selected = string.Equals(task.ToolTypeName, "scythe", StringComparison.OrdinalIgnoreCase)
                        ? this.SelectSlot(i => i is MeleeWeapon mw && mw.isScythe())
                        : (ToolType(task.ToolTypeName) is Type tt && this.SelectSlot(i => tt.IsInstanceOfType(i)));
                    if (!selected)
                    {
                        this.lastResult = new { action = "farm.tool", success = false, detail = $"tool not found: {task.ToolTypeName}" };
                        this.actionCooldown = 10;
                        return;
                    }
                    this.PressUseTool();
                    this.lastResult = new { action = "farm.tool", success = true, detail = $"{task.ToolTypeName} swing at ({(int)tile.X},{(int)tile.Y})" };
                    this.actionCooldown = 50;
                    break;
                }

                case FarmTaskType.Interact:
                    this.PressActionButton();
                    this.lastResult = new { action = "farm.interact", success = true, detail = $"interact click at ({(int)tile.X},{(int)tile.Y})" };
                    this.actionCooldown = 25;
                    break;
            }
        }

        /// <summary>Stand in place and swing the equipped tool repeatedly, waiting for
        /// each swing animation to finish before the next - like a human holding the button.
        /// Ported from stardew-mcp's ProcessToolUse.</summary>
        private void ProcessToolRepeat()
        {
            if (this.toolRepeatCooldown > 0)
            {
                this.toolRepeatCooldown--;
                Game1.lastCursorMotionWasMouse = false;
                return;
            }

            var player = Game1.player;
            if (player.UsingTool || !Context.CanPlayerMove)
            {
                Game1.lastCursorMotionWasMouse = false;
                return; // wait out the current swing animation / transition
            }

            this.PressUseTool();
            this.toolRepeatRemaining--;
            this.toolRepeatCooldown = ToolRepeatCooldownTicks;

            if (this.toolRepeatRemaining <= 0)
                this.lastResult = new { action = "player_use_tool_repeat", success = true, detail = "done" };
        }

        /// <summary>Delayed check for input-simulated planting: if the click planted the
        /// seed, done; otherwise use the vanilla placement path (Object.placementAction),
        /// which validates season/location and consumes the seed only on success.</summary>
        private void VerifyPlant()
        {
            if (--this.plantVerifyTicks > 0) return;

            var tile = this.plantVerifyTile.Value;
            this.plantVerifyTile = null;
            string seedName = this.plantSeedName;
            this.plantSeedName = null;

            var loc = Game1.player?.currentLocation;
            if (loc == null) return;

            bool planted = loc.terrainFeatures.TryGetValue(tile, out var f)
                && f is HoeDirt dirt && dirt.crop != null;
            if (planted)
            {
                this.lastResult = new { action = "farm.plant", success = true, tile = new { x = (int)tile.X, y = (int)tile.Y } };
                return;
            }

            bool ok = CompanionActions.PlantTile(loc, tile, this.monitor, seedName);
            this.lastResult = new { action = "farm.plant", success = ok, detail = ok ? "planted (placement fallback)" : "plant failed" };
        }

        // Trigger the real vanilla end-of-day. Must be called while inside the FarmHouse
        // and free to move. Mirrors the bed interaction path so the day advances and the
        // save/shipping flow runs exactly as if the human had slept.
        private void TrySleep()
        {
            this.pendingSleep = false;
            this.Mode = PilotMode.Idle;
            this.ClearMovement();
            this.executeOnArrive = false;
            this.currentTask = null;
            Game1.player.Halt();
            Game1.player.isInBed.Value = true;
            Game1.currentLocation.answerDialogueAction("Sleep_Yes", null);
            this.lastResult = new { action = "player_sleep", success = true, detail = "Sleeping - ending the day" };
            this.monitor.Log("Player: player_sleep - ending the day via Sleep_Yes", LogLevel.Info);
        }

        private static Type ToolType(string name)
        {
            return (name ?? "").ToLower() switch
            {
                "pickaxe" => typeof(Pickaxe),
                "axe" => typeof(Axe),
                "hoe" => typeof(Hoe),
                "wateringcan" or "watering_can" => typeof(WateringCan),
                "scythe" => typeof(MeleeWeapon), // 1.6: scythe is a MeleeWeapon (isScythe)
                "sword" or "weapon" => typeof(MeleeWeapon),
                _ => null
            };
        }

        // ======================
        // COMMAND HANDLING
        // ======================

        public void HandleCommand(string action, System.Text.Json.JsonElement root)
        {
            if (!Context.IsWorldReady || Game1.player == null)
            {
                this.lastResult = new { action, success = false, detail = "world not ready" };
                return;
            }

            try
            {
                switch (action)
                {
                    case "player_move_to":
                    {
                        int x = root.GetProperty("x").GetInt32();
                        int y = root.GetProperty("y").GetInt32();
                        this.Mode = PilotMode.Manual;
                        this.executeOnArrive = false;
                        this.currentTask = null;
                        if (this.StartPath(x, y))
                            this.lastResult = new { action, success = true, detail = $"Walking to ({x},{y})" };
                        else
                            this.lastResult = new { action, success = false, detail = $"No path to ({x},{y})" };
                        break;
                    }

                    case "player_farm":
                        // Idempotent: re-issuing this must NOT cancel an in-progress path.
                        if (this.Mode != PilotMode.Farm)
                        {
                            this.Mode = PilotMode.Farm;
                            this.ClearMovement();
                            this.executeOnArrive = false;
                            this.currentTask = null;
                            this.actionCooldown = 0;
                            this.lastResult = new { action, success = true, detail = "Autonomous farming started" };
                        }
                        else
                        {
                            this.lastResult = new { action, success = true, detail = "Already farming" };
                        }
                        break;

                    case "player_stop":
                    case "player_idle":
                        this.Mode = PilotMode.Idle;
                        this.ClearMovement();
                        this.executeOnArrive = false;
                        this.currentTask = null;
                        Game1.player.Halt();
                        this.lastResult = new { action, success = true, detail = "Idle" };
                        break;

                    case "player_use_tool":
                    {
                        string toolName = root.GetProperty("tool").GetString();
                        int x = root.GetProperty("x").GetInt32();
                        int y = root.GetProperty("y").GetInt32();
                        Type tt = ToolType(toolName);
                        if (tt == null)
                        {
                            this.lastResult = new { action, success = false, detail = $"Unknown tool: {toolName}" };
                            break;
                        }
                        var tile = new Vector2(x, y);
                        this.Mode = PilotMode.Manual;
                        if (Vector2.Distance(Game1.player.Tile, tile) <= 1.6f)
                        {
                            this.ClearMovement();
                            this.ExecuteFarmAction(Game1.player.currentLocation,
                                new FarmTask { Type = FarmTaskType.ToolUse, Tile = tile, ToolTypeName = toolName });
                        }
                        else
                        {
                            var approach = this.FindApproachTile(Game1.player.currentLocation, tile);
                            if (approach == null || !this.StartPath((int)approach.Value.X, (int)approach.Value.Y))
                            {
                                this.lastResult = new { action, success = false, detail = "no reachable tile near target" };
                                break;
                            }
                            this.currentTask = new FarmTask { Type = FarmTaskType.ToolUse, Tile = tile, ToolTypeName = toolName };
                            this.executeOnArrive = true;
                            this.lastResult = new { action, success = true, detail = $"Walking to use {toolName} at ({x},{y})" };
                        }
                        break;
                    }

                    case "player_plant":
                    {
                        int x = root.GetProperty("x").GetInt32();
                        int y = root.GetProperty("y").GetInt32();
                        string seedName = root.TryGetProperty("seed", out var seedProp) ? seedProp.GetString() : null;
                        var tile = new Vector2(x, y);
                        this.Mode = PilotMode.Manual;
                        if (Vector2.Distance(Game1.player.Tile, tile) <= 1.6f)
                        {
                            this.ClearMovement();
                            this.ExecuteFarmAction(Game1.player.currentLocation,
                                new FarmTask { Type = FarmTaskType.Plant, Tile = tile, SeedName = seedName });
                        }
                        else
                        {
                            var approach = this.FindApproachTile(Game1.player.currentLocation, tile);
                            if (approach == null || !this.StartPath((int)approach.Value.X, (int)approach.Value.Y))
                            {
                                this.lastResult = new { action, success = false, detail = "no reachable tile near target" };
                                break;
                            }
                            this.currentTask = new FarmTask { Type = FarmTaskType.Plant, Tile = tile, SeedName = seedName };
                            this.executeOnArrive = true;
                            this.lastResult = new { action, success = true, detail = $"Walking to plant at ({x},{y})" };
                        }
                        break;
                    }

                    case "player_inspect":
                    {
                        // Look at a tile (default: the one the player faces). The agent reads
                        // the answer from agentPlayer.lastCommandResult in the next state sync.
                        int x, y;
                        if (root.TryGetProperty("x", out var ix) && root.TryGetProperty("y", out var iy))
                        {
                            x = ix.GetInt32(); y = iy.GetInt32();
                        }
                        else
                        {
                            var dirV = Game1.player.FacingDirection switch
                            {
                                0 => new Vector2(0, -1),
                                1 => new Vector2(1, 0),
                                2 => new Vector2(0, 1),
                                _ => new Vector2(-1, 0),
                            };
                            var ft = Game1.player.Tile + dirV;
                            x = (int)ft.X; y = (int)ft.Y;
                        }
                        var loc = Game1.player.currentLocation;
                        var tile = new Vector2(x, y);
                        object info;
                        if (loc.terrainFeatures.TryGetValue(tile, out var feat) && feat is HoeDirt dirt)
                        {
                            info = new
                            {
                                kind = "HoeDirt",
                                watered = dirt.state.Value == 1,
                                hasCrop = dirt.crop != null,
                                readyForHarvest = dirt.crop != null && dirt.readyForHarvest(),
                                cropPhase = dirt.crop != null ? (int)dirt.crop.currentPhase.Value : -1,
                                fullyGrown = dirt.crop != null && dirt.crop.fullyGrown.Value,
                            };
                        }
                        else if (loc.objects.TryGetValue(tile, out var obj))
                        {
                            info = new { kind = "Object", name = obj.Name, displayName = obj.DisplayName };
                        }
                        else
                        {
                            info = new
                            {
                                kind = "Ground",
                                walkable = this.pathfinder.IsTileWalkable(loc, x, y),
                                diggable = loc.doesTileHaveProperty(x, y, "Diggable", "Back") != null,
                            };
                        }
                        this.lastResult = new { action, success = true, tile = new { x, y }, info };
                        break;
                    }

                    case "player_warp":
                    {
                        string loc = root.GetProperty("location").GetString();
                        int x = root.GetProperty("x").GetInt32();
                        int y = root.GetProperty("y").GetInt32();
                        // Re-warping to the location you are ALREADY in still triggers a
                        // fade-to-black transition; skip it to stop repeated screen flashing.
                        if (string.Equals(Game1.currentLocation?.Name, loc, StringComparison.OrdinalIgnoreCase))
                        {
                            this.lastResult = new { action, success = true, detail = $"Already in {loc}; warp skipped" };
                            break;
                        }
                        this.Mode = PilotMode.Idle;
                        this.ClearMovement();
                        this.executeOnArrive = false;
                        this.currentTask = null;
                        Game1.warpFarmer(loc, x, y, false);
                        this.lastResult = new { action, success = true, detail = $"Warped to {loc} ({x},{y})" };
                        break;
                    }

                    case "player_face":
                    {
                        int dir = root.GetProperty("direction").GetInt32();
                        if (dir >= 0 && dir <= 3)
                        {
                            Game1.player.faceDirection(dir);
                            this.lastResult = new { action, success = true, detail = $"Facing {dir}" };
                        }
                        else
                        {
                            this.lastResult = new { action, success = false, detail = "direction must be 0-3" };
                        }
                        break;
                    }

                    case "player_interact":
                    {
                        int x = root.GetProperty("x").GetInt32();
                        int y = root.GetProperty("y").GetInt32();
                        var tile = new Vector2(x, y);
                        this.Mode = PilotMode.Manual;
                        if (Vector2.Distance(Game1.player.Tile, tile) <= 1.6f)
                        {
                            this.ClearMovement();
                            this.ExecuteFarmAction(Game1.player.currentLocation,
                                new FarmTask { Type = FarmTaskType.Interact, Tile = tile });
                        }
                        else
                        {
                            var approach = this.FindApproachTile(Game1.player.currentLocation, tile);
                            if (approach == null || !this.StartPath((int)approach.Value.X, (int)approach.Value.Y))
                            {
                                this.lastResult = new { action, success = false, detail = "no reachable tile near target" };
                                break;
                            }
                            this.currentTask = new FarmTask { Type = FarmTaskType.Interact, Tile = tile };
                            this.executeOnArrive = true;
                            this.lastResult = new { action, success = true, detail = $"Walking to interact at ({x},{y})" };
                        }
                        break;
                    }

                    case "player_attack":
                    {
                        this.Mode = PilotMode.Manual;
                        if (!this.SelectSlot(i => i is MeleeWeapon))
                        {
                            this.lastResult = new { action, success = false, detail = "no weapon in hotbar" };
                            break;
                        }
                        this.PressUseTool();
                        this.lastResult = new { action, success = true, detail = "weapon swing" };
                        break;
                    }

                    case "player_sleep":
                        // End the day for real. Vanilla bed interaction runs
                        // answerDialogueAction("Sleep_Yes") -> startSleep() -> Game1.NewDay().
                        // If we're not home, warp to the farmhouse and finish sleeping on a
                        // later tick once the warp fade has settled (see pendingSleep in Tick).
                        if (Game1.currentLocation is FarmHouse)
                        {
                            this.TrySleep();
                        }
                        else if (!this.pendingSleep)
                        {
                            this.Mode = PilotMode.Idle;
                            this.ClearMovement();
                            this.executeOnArrive = false;
                            this.currentTask = null;
                            Game1.warpFarmer("FarmHouse", 3, 11, false);
                            this.pendingSleep = true;
                            this.lastResult = new { action, success = true, detail = "Warping home to sleep" };
                        }
                        else
                        {
                            this.lastResult = new { action, success = true, detail = "Already heading to bed" };
                        }
                        break;

                    case "player_select_item":
                    {
                        // Select a hotbar slot (0-11), like a human pressing a number key.
                        int slot = root.GetProperty("slot").GetInt32();
                        if (slot < 0 || slot > 11)
                        {
                            this.lastResult = new { action, success = false, detail = "slot must be 0-11 (hotbar)" };
                            break;
                        }
                        if (slot >= Game1.player.Items.Count || Game1.player.Items[slot] == null)
                        {
                            this.lastResult = new { action, success = false, detail = $"no item in slot {slot}" };
                            break;
                        }
                        Game1.player.CurrentToolIndex = slot;
                        this.lastResult = new { action, success = true, detail = $"selected {Game1.player.Items[slot].DisplayName} (slot {slot})" };
                        break;
                    }

                    case "player_eat":
                    {
                        // Eat to restore stamina/health via the native right-click path
                        // (holding food + action button = eat). Ported from stardew-mcp.
                        int slot = root.TryGetProperty("slot", out var sp)
                            ? sp.GetInt32()
                            : this.FindSlot(i => i is StardewValley.Object so && so.Edibility > -300);

                        if (slot < 0 || slot > 11 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] == null)
                        {
                            this.lastResult = new { action, success = false, detail = "no edible item in hotbar" };
                            break;
                        }
                        if (Game1.player.Items[slot] is not StardewValley.Object food || food.Edibility <= -300)
                        {
                            this.lastResult = new { action, success = false, detail = $"{Game1.player.Items[slot].Name} is not edible" };
                            break;
                        }
                        Game1.player.CurrentToolIndex = slot;
                        this.PressActionButton();
                        this.lastResult = new { action, success = true, detail = $"eating {food.DisplayName}" };
                        break;
                    }

                    case "player_enter_door":
                    {
                        // Walk through the door/warp the player is facing (native right-click).
                        var dirV = Game1.player.FacingDirection switch
                        {
                            0 => new Vector2(0, -1),
                            1 => new Vector2(1, 0),
                            2 => new Vector2(0, 1),
                            _ => new Vector2(-1, 0),
                        };
                        var ft = Game1.player.Tile + dirV;
                        var curLoc = Game1.currentLocation;
                        string targetName = null;
                        foreach (var w in curLoc.warps)
                        {
                            if (w.X == (int)ft.X && w.Y == (int)ft.Y) { targetName = w.TargetName; break; }
                        }
                        if (targetName == null && curLoc.doors.ContainsKey(new Point((int)ft.X, (int)ft.Y)))
                            targetName = "interior";
                        this.PressActionButton();
                        this.lastResult = new { action, success = true, detail = targetName != null ? $"entering door to {targetName}" : "no door/warp on the faced tile; action pressed anyway" };
                        break;
                    }

                    case "player_use_tool_repeat":
                    {
                        // Swing the currently-equipped tool N times in place (mines/field
                        // clearing). Ported from stardew-mcp's use_tool_repeat.
                        int count = root.TryGetProperty("count", out var cp) ? cp.GetInt32() : 1;
                        count = Math.Clamp(count, 1, 100);
                        if (Game1.player.CurrentTool == null)
                        {
                            this.lastResult = new { action, success = false, detail = "no tool equipped; use player_select_item first" };
                            break;
                        }
                        this.Mode = PilotMode.Manual;
                        this.ClearMovement();
                        this.toolRepeatRemaining = count;
                        this.toolRepeatCooldown = 0; // first swing fires immediately
                        this.lastResult = new { action, success = true, detail = $"swinging {Game1.player.CurrentTool.Name} x{count}" };
                        break;
                    }

                    default:
                        this.lastResult = new { action, success = false, detail = "unknown player command" };
                        break;
                }

                this.monitor.Log($"Player: {action} — {System.Text.Json.JsonSerializer.Serialize(this.lastResult)}", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.lastResult = new { action, success = false, detail = $"error: {ex.Message}" };
                this.monitor.Log($"Player command {action} failed: {ex.Message}", LogLevel.Error);
            }
        }

        // ======================
        // BRIDGE STATUS
        // ======================

        public object GetStatus()
        {
            if (!Context.IsWorldReady || Game1.player == null) return null;

            var loc = Game1.player.currentLocation;
            object surroundings = null;
            try
            {
                var scan = SurroundingsScanner.Scan(loc, Game1.player.Tile, 8);
                surroundings = new
                {
                    tiles = scan.Tiles.Select(t => new
                    {
                        x = t.X, y = t.Y,
                        passable = t.Passable,
                        water = t.IsWater,
                        terrain = t.Terrain,
                        crop = t.CropName,
                        cropReady = t.CropReady,
                        waterState = t.WaterState,
                        obj = t.ObjectName,
                        objType = t.ObjectType,
                        breakable = t.Breakable,
                        interactable = t.Interactable
                    }),
                    monsters = scan.Monsters.Select(m => new { name = m.Name, x = m.X, y = m.Y, health = m.Health, maxHealth = m.MaxHealth }),
                    npcs = scan.Npcs.Select(n => new { name = n.Name, x = n.X, y = n.Y })
                };
            }
            catch { }

            return new
            {
                mode = this.Mode.ToString().ToLower(),
                tile = new { x = (int)Game1.player.Tile.X, y = (int)Game1.player.Tile.Y },
                facing = Game1.player.FacingDirection,
                moving = this.path != null,
                target = this.finalTarget.HasValue ? (object)new { x = (int)this.finalTarget.Value.X, y = (int)this.finalTarget.Value.Y } : null,
                pathRemaining = this.path != null ? this.path.Count - this.pathIndex : 0,
                canMove = Context.CanPlayerMove,
                stamina = Game1.player.Stamina,
                maxStamina = Game1.player.MaxStamina,
                currentTool = Game1.player.CurrentTool?.Name,
                currentItem = Game1.player.CurrentItem?.DisplayName,
                toolRepeatRemaining = this.toolRepeatRemaining,
                farmQueueSize = this.farmQueue?.Count ?? 0,
                lastCommandResult = this.lastResult,
                inventory = Game1.player.Items.Select(i => i == null ? null : new
                {
                    name = i.DisplayName,
                    stack = i.Stack,
                    category = i.Category,
                    isSeed = i.Category == -74,
                    edible = i is StardewValley.Object sobj && sobj.Edibility > -300,
                }).ToList(),
                surroundings
            };
        }
    }
}
