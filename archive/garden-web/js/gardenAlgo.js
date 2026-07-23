// 镜园 FlowGarden · 算法花园布局引擎（设计指南 v3.0 §3.10）
// 借鉴 Pollinator Pathmaker：不是人类设计师摆放每一株植物，
// 而是用户的睡眠/专注数据，通过算法规则，自己决定花园的样子。
//
// 架构说明：本模块为【纯函数/无副作用】——输入用户数据 → 输出布局与参数。
// 本地算力即可运行（192 格 × 6 物种）；未来可原样搬到 Zeabur 云端作为花园计算服务。

// ── 植物调色板（§3.10.3 Plant Palette v1.0）──────────────
// 规则："不同花型适配不同状态" / "确保全年有花" / "避免人造对称" / "非花期植物也是花园"
export const PLANT_PALETTE = {
  flower_a: {
    name: '晨曦雏菊', shape: 'disc',            // 碟状花（扁十二面体）
    trigger: 'focus',                          // 浅度专注触发
    colors: [0xf7d0d8, 0xf2a7b5, 0xe89ac0],    // 柔粉系
    height: [0.3, 0.55], size: [0.8, 1.1], pollinator: '日常陪伴',
  },
  flower_b: {
    name: '星夜薰衣草', shape: 'spike',          // 穗状花（叠八面体）
    trigger: 'deep_focus',                     // 深度心流触发
    colors: [0xddc0e8, 0xc9a5d6, 0xa88ab8],    // 淡紫系
    height: [0.55, 0.9], size: [0.75, 1.05], pollinator: '高效产出',
  },
  flower_c: {
    name: '暖阳金盏花', shape: 'ball',           // 球状花（二十面体）
    trigger: 'streak3',                        // 连续 3 天自律
    colors: [0xf7e98e, 0xf5d76e, 0xf0c27a],    // 奶油黄系
    height: [0.4, 0.7], size: [0.9, 1.25], pollinator: '坚持奖励',
  },
  vine_a: {
    name: '时光常春藤', shape: 'bell',           // 钟状花（六棱锥）
    trigger: 'hours5',                         // 累计专注 >5h
    colors: [0xffffff, 0xf5f0e8, 0xe8f0dd],    // 白色系
    height: [0.5, 0.85], size: [0.7, 1.0], pollinator: '成长见证',
  },
  bush_a: {
    name: '庇护绣球', shape: 'ball',
    trigger: 'hours20',                        // 累计专注 >20h
    colors: [0xa8c8e8, 0x9ab8dd, 0xc0d8f0],    // 绣球蓝系
    height: [0.35, 0.6], size: [1.2, 1.6], pollinator: '安全空间',
  },
  rare_s: {
    name: '极光兰', shape: 'orchid',
    trigger: 'rare',                           // 深度心流>70% + 连续7天
    colors: [0xf5c842], size: [1.6, 1.9], height: [0.8, 1.1],
    pollinator: '巅峰体验',
  },
};

// 物种选择权重（常见→稀有）
const SPECIES_WEIGHTS = [
  ['flower_a', 0.30], ['flower_b', 0.26], ['flower_c', 0.22],
  ['vine_a', 0.14], ['bush_a', 0.08],
];

// ── 规则引擎（§3.10.2，纯函数）────────────────────────────
// 输入：用户数据快照；输出：今日花园参数
export function evaluateGardenRules({
  deepSleepRatio = 0.58,   // 昨晚深睡比例 0-1
  focusDeepRatio = 0.45,   // 昨日深度心流占比 0-1
  streakDays = 3,          // 连续自律天数
  totalFocusHours = 6,     // 累计专注时长 h
  distractionCount = 0,    // 今日分心次数
} = {}) {
  // 规则1：植物密度 ∝ 深睡质量
  const density = 0.3 + deepSleepRatio * 0.7;
  // 规则2：生长速度 ∝ 专注深度
  const growthRate = 0.1 + focusDeepRatio * 0.9;
  // 规则3：稀有花概率 ∝ 一致性
  const rareProb = Math.min(streakDays / 7, 1.0) * 0.3;
  // 规则4：分心代价 = 生长暂停（不逆转）——由调用方执行暂停计时
  const growthPauseMin = distractionCount * 10;
  // 规则5：花园区块解锁 ∝ 累计专注时长（3×3 区块，索引见下）
  const unlockedZones = [4]; // 中心庭院初始解锁
  if (totalFocusHours > 0.5) unlockedZones.push(1, 3, 5, 7);     // 四边（演示低门槛）
  if (totalFocusHours > 5) unlockedZones.push(6);                // 西南角
  if (totalFocusHours > 20) unlockedZones.push(2);               // 东北角
  if (totalFocusHours > 50) unlockedZones.push(0, 8);            // 西北/东南角

  return {
    density, growthRate, rareProb, growthPauseMin, unlockedZones,
    rareSpawnToday: Math.random() < rareProb,
  };
}

// ── 网格常量（§3.2）──────────────────────────────────────
export const GRID = {
  COLS: 16, ROWS: 12,
  CELL: 0.92,                       // 世界单位/格
  get width() { return this.COLS * this.CELL; },
  get height() { return this.ROWS * this.CELL; },
  // 格 → 世界坐标（格中心）
  toWorld(col, row) {
    return {
      x: (col - (this.COLS - 1) / 2) * this.CELL,
      z: (row - (this.ROWS - 1) / 2) * this.CELL,
    };
  },
  // 格 → 区块索引 0-8（3×3 区块）
  zoneOf(col, row) {
    return Math.floor(row / 4) * 3 + Math.floor(col / 5.34);
  },
};

// ── drifts 色带布局生成（§3.10.1 "大胆色带 × 高矮并置"）─────
// Pollinator 的标志性审美：不是整齐花圃，而是河流状色带蜿蜒穿过花园。
// 算法：3-4 条正弦色带横贯网格，每格归属最近的色带 → 带内同色系、花形混合。
function buildDrifts(rng) {
  const drifts = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    drifts.push({
      baseRow: 1.5 + i * 3,                  // 色带中心行
      amp: rng(0.6, 1.4),                    // 蜿蜒振幅
      freq: rng(0.35, 0.6),                  // 蜿蜒频率
      phase: rng(0, Math.PI * 2),
      width: rng(1.3, 2.1),                  // 色带半宽（格）
      species: SPECIES_WEIGHTS[i % SPECIES_WEIGHTS.length][0],
    });
  }
  return drifts;
}

// 简易可复现随机（种子化，保证同一天布局稳定）
function seededRandom(seed) {
  let s = seed >>> 0;
  return (a = 0, b = 1) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return a + (s / 4294967296) * (b - a);
  };
}

// ── 布局生成主函数（纯函数，未来可上云）────────────────────
// 输入：规则参数 + 种子（日期）；输出：每格种植计划
export function generateLayout(rules, seed = 20260723) {
  const rng = seededRandom(seed);
  const drifts = buildDrifts(rng);
  const cells = [];

  for (let row = 0; row < GRID.ROWS; row++) {
    for (let col = 0; col < GRID.COLS; col++) {
      const zone = GRID.zoneOf(col, row);
      const unlocked = rules.unlockedZones.includes(zone);

      // 蜿蜒色带归属：找距离最近的色带
      let best = null, bestDist = Infinity;
      for (const d of drifts) {
        const driftRow = d.baseRow + Math.sin(col * d.freq + d.phase) * d.amp;
        const dist = Math.abs(row - driftRow);
        if (dist < bestDist) { bestDist = dist; best = d; }
      }
      const inDrift = bestDist <= best.width;

      // 密度判定：色带内高密度、带外稀疏留白（Pollinator 的"呼吸感"）
      const localDensity = inDrift ? rules.density : rules.density * 0.22;
      const planted = unlocked && rng() < localDensity;

      // 物种：色带物种为主（75%），混入邻近物种制造"戏剧性色彩冲突"
      let species = best.species;
      if (rng() < 0.25) {
        const alt = drifts[(drifts.indexOf(best) + 1) % drifts.length];
        species = alt.species;
      }

      cells.push({
        col, row, zone, unlocked, inDrift,
        planted,
        species: planted ? species : null,
        tall: planted && rng() < 0.22,        // 高矮并置 22%
        jitterX: rng(-0.22, 0.22),            // 反人造对称：格内随机偏移
        jitterZ: rng(-0.22, 0.22),
        rot: rng(0, Math.PI * 2),
        sizeK: rng(0.85, 1.2),
      });
    }
  }
  return { cells, drifts };
}

// 专注轨迹（§3.10.4 Focus Traplines）：由今日专注 session 序列生成路径点
// 演示版：预生成一条蜿蜒穿越色带的金色路径
export function generateTrapline(seed = 7) {
  const rng = seededRandom(seed);
  const points = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const col = 1 + (i / (n - 1)) * (GRID.COLS - 2);
    const row = 5.5 + Math.sin(i * 1.1 + rng(0, 2)) * 3.2;
    const w = GRID.toWorld(col, row);
    points.push({ x: w.x, z: w.z, depth: rng(0.4, 1) }); // depth ∝ 专注深度 → 路径宽度
  }
  return points;
}
