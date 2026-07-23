// 镜园 FlowGarden · 5 状态视觉映射表（设计指南 v2.0 · 塞尚块面版 §3.3 / §3.4）
// 每个状态：5 级亮度色阶（L5最亮面→L1暗面）+ 天空三块面色 + 硬边光束层级
// 状态切换：全部 5 层同步渐变 2s power2.inOut（§8.2）

export const STATES = {
  // 深度心流 —— 暖金色块面层叠，5 层硬边光束全显，金色小三角 ◆ 上升
  deep_focus: {
    label: '深度心流',
    icon: '☀️',
    scale: [0xfff8e1, 0xf5d76e, 0xf0c27a, 0xd4a96a, 0xb8893d], // L5→L1
    sky: { hi: 0xf2d5a3, mid: 0xe8c48a, lo: 0xd4a96a },        // 暖杏→蜂蜜→琥珀
    fog: 0xddb984,
    hemiSky: 0xf2d5a3,
    hemiGround: 0x6da85d,
    hemiInt: 0.62,
    sunColor: 0xffe9b0,
    sunInt: 2.0,
    sunPos: [-6, 10, 2],
    beamLayers: 5,      // 5 层全显
    beamWeight: 1.0,
    vignette: 0.05,
    night: 0,
    dusk: 0,
    droop: 0,
    particles: { pollen: 1, drift: 0, leaves: 0, fireflies: 0, dust: 0 },
    quote: '光束进来了……保持这个节奏，花园在跟着你生长。',
  },

  // 浅度专注 —— 柔白偏暖大块色面，光束减至 2-3 层，白色小方块 ■ 漂浮
  focus: {
    label: '浅度专注',
    icon: '🌤️',
    scale: [0xfaf7f2, 0xf2ede4, 0xddd5c5, 0xc8bda8, 0xa8987e],
    sky: { hi: 0xe8e0d5, mid: 0xc9d5e0, lo: 0xa8b8c8 },        // 奶油→灰蓝→石板蓝
    fog: 0xc2c0b4,
    hemiSky: 0xf2ede4,
    hemiGround: 0x72a85d,
    hemiInt: 0.58,
    sunColor: 0xfff2dc,
    sunInt: 1.55,
    sunPos: [-5, 9, 3],
    beamLayers: 3,
    beamWeight: 0.45,
    vignette: 0.10,
    night: 0,
    dusk: 0,
    droop: 0,
    particles: { pollen: 0, drift: 1, leaves: 0, fireflies: 0, dust: 0 },
    quote: '我修剪一下枝叶。你继续，别急。',
  },

  // 分心标记 —— 冷灰色面，光束消失画面变平，棕色几何碎片 ◢ 飘落 10s
  distracted: {
    label: '分心标记',
    icon: '🌧️',
    scale: [0xe8ebed, 0xd5d8dc, 0xb8bdc4, 0x9ba1a9, 0x7a8088],
    sky: { hi: 0xd5d8dc, mid: 0xb8bdc4, lo: 0x9ba1a9 },
    fog: 0xa4aab2,
    hemiSky: 0xd5d8dc,
    hemiGround: 0x558a40,
    hemiInt: 0.9,               // 所有面亮度趋同 → 画面变平
    sunColor: 0xdde3ea,
    sunInt: 0.5,
    sunPos: [-4, 9, 3],
    beamLayers: 0,
    beamWeight: 0,
    vignette: 0.20,
    night: 0,
    dusk: 0,
    droop: 0.04,
    particles: { pollen: 0, drift: 0, leaves: 1, fireflies: 0, dust: 0 },
    quote: '分心没关系的——说实话的你，比完美更珍贵。',
  },

  // 疲惫 —— 暖橙陶土色面，低角度黄昏光束，植物暗面占比增大
  tired: {
    label: '疲惫黄昏',
    icon: '🌅',
    scale: [0xf0c8a0, 0xd4784a, 0xb8553a, 0x8b3a2a, 0x5a2218],
    sky: { hi: 0xd4784a, mid: 0xb8553a, lo: 0x8b3a2a },        // 陶土橙→焦赭→深棕红
    fog: 0xa86a48,
    hemiSky: 0xd4784a,
    hemiGround: 0x628a3c,
    hemiInt: 0.5,
    sunColor: 0xffb877,
    sunInt: 1.3,
    sunPos: [-9, 2.8, 1],
    beamLayers: 2,
    beamWeight: 0.5,
    vignette: 0.30,
    night: 0,
    dusk: 1,
    droop: 0.1,
    particles: { pollen: 0, drift: 0, leaves: 0, fireflies: 0, dust: 1 },
    quote: '黄昏了。你今天已经很努力了，揉揉眼睛吧。',
  },

  // 休息/月夜 —— 钴蓝→靛蓝大块色面，月光多边形光束，黄绿发光多面体萤火虫
  night: {
    label: '休息月夜',
    icon: '🌙',
    scale: [0x5a6a8a, 0x3a4a6b, 0x2a3552, 0x1a2038, 0x0d1220],
    sky: { hi: 0x3a4a6b, mid: 0x2a3552, lo: 0x1a2038 },        // 钴蓝→靛蓝→深墨蓝
    fog: 0x232c48,
    hemiSky: 0x3a4a6b,
    hemiGround: 0x1a3514,
    hemiInt: 0.4,
    sunColor: 0x9fb4de,  // 月光
    sunInt: 0.75,
    sunPos: [7, 8, -2],
    beamLayers: 2,
    beamWeight: 0.35,   // 月光多边光束，逐级冷蓝
    vignette: 0.35,
    night: 1,
    dusk: 0,
    droop: 0.05,
    particles: { pollen: 0, drift: 0, leaves: 0, fireflies: 1, dust: 0 },
    quote: '晚安。月光守着花园，我守着你。',
  },
};

export const STATE_ORDER = ['deep_focus', 'focus', 'distracted', 'tired', 'night'];
