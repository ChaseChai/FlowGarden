// 镜园 FlowGarden · 天气计算引擎（设计指南 v3.0 §3.4）
// 花园的天气 = 真实天气 API × 用户身心状态 —— 不是随机的，而是有根有据的双重计算。
// 本模块为纯配置+纯函数：视觉映射表 + weather 计算，未来真实 API 只换 fetchRealWeather。

// ── 7 种花园天气 × 视觉映射（§3.4 表）────────────────────
export const WEATHERS = {
  sunny_gold: {  // ☀️ 晴·金色（真实晴 + 深睡好 + 心流）
    label: '晴 · 金色', icon: '☀️',
    overlay: { color: '#F5D76E', alpha: 0.10 },
    particle: 'pollen',
    sky: { hi: 0xf2d5a3, mid: 0xe8c48a, lo: 0xd4a96a },
    fog: 0xddb984,
    hemiSky: 0xf2d5a3, hemiGround: 0x6da85d, hemiInt: 0.62,
    sunColor: 0xffe9b0, sunInt: 2.0, sunPos: [-6, 10, 2],
    ground: 0x9cc06f, beamLayers: 5, beamWeight: 1.0,
    growthMod: 1.2, vignette: 0.05, night: 0, dusk: 0,
    quote: '今天阳光真好，花园会很快乐的。',
  },
  sunny_gray: {  // 🌤️ 晴·灰调（真实晴 + 深睡差 + 疲惫）
    label: '晴 · 灰调', icon: '🌤️',
    overlay: { color: '#F5D76E', alpha: 0.05 },
    particle: 'drift',
    sky: { hi: 0xe8ddc8, mid: 0xd4c8ae, lo: 0xb8a888 },
    fog: 0xc8bda0,
    hemiSky: 0xe8ddc8, hemiGround: 0x72a85d, hemiInt: 0.55,
    sunColor: 0xf5e0b8, sunInt: 1.3, sunPos: [-5, 9, 3],
    ground: 0x8fb663, beamLayers: 2, beamWeight: 0.4,
    growthMod: 1.0, vignette: 0.12, night: 0, dusk: 0,
    quote: '有太阳，但今天我们都慢一点。',
  },
  cloudy: {  // ⛅ 多云·柔白（真实多云 + 专注中）
    label: '多云 · 柔白', icon: '⛅',
    overlay: { color: '#FAF7F2', alpha: 0.10 },
    particle: 'drift',
    sky: { hi: 0xe8e0d5, mid: 0xc9d5e0, lo: 0xa8b8c8 },
    fog: 0xc2c0b4,
    hemiSky: 0xf2ede4, hemiGround: 0x72a85d, hemiInt: 0.58,
    sunColor: 0xfff2dc, sunInt: 1.55, sunPos: [-5, 9, 3],
    ground: 0x9cc06f, beamLayers: 3, beamWeight: 0.45,
    growthMod: 1.1, vignette: 0.10, night: 0, dusk: 0,
    quote: '柔光正好，不急不躁。',
  },
  overcast: {  // ☁️ 阴·冷灰（真实阴 + 分心）
    label: '阴 · 冷灰', icon: '☁️',
    overlay: { color: '#D5D8DC', alpha: 0.15 },
    particle: 'dust',
    sky: { hi: 0xd5d8dc, mid: 0xb8bdc4, lo: 0x9ba1a9 },
    fog: 0xa4aab2,
    hemiSky: 0xd5d8dc, hemiGround: 0x558a40, hemiInt: 0.9,
    sunColor: 0xdde3ea, sunInt: 0.5, sunPos: [-4, 9, 3],
    ground: 0x82a95c, beamLayers: 0, beamWeight: 0,
    growthMod: 0.9, vignette: 0.20, night: 0, dusk: 0,
    quote: '天有点灰——没关系，灰天也是天气的一种。',
  },
  rain: {  // 🌧️ 雨·冷蓝（真实雨，任何状态）
    label: '雨 · 冷蓝', icon: '🌧️',
    overlay: { color: '#7A9AC8', alpha: 0.20 },
    particle: 'rain',
    sky: { hi: 0x6a7a92, mid: 0x55647a, lo: 0x3e4c60 },
    fog: 0x4e5c72,
    hemiSky: 0x6a7a92, hemiGround: 0x3d5c30, hemiInt: 0.7,
    sunColor: 0x9ab0cc, sunInt: 0.6, sunPos: [-3, 9, 2],
    ground: 0x5a7a48, beamLayers: 0, beamWeight: 0,
    growthMod: 0, vignette: 0.28, night: 0, dusk: 0,
    quote: '下雨了，但花园也需要雨水。',
  },
  snow: {  // ❄️ 雪·白（真实雪，任何状态）
    label: '雪 · 白', icon: '❄️',
    overlay: { color: '#FFFFFF', alpha: 0.30 },
    particle: 'snow',
    sky: { hi: 0xe8ecf0, mid: 0xd0d8e0, lo: 0xb0bcc8 },
    fog: 0xc8d0da,
    hemiSky: 0xe8ecf0, hemiGround: 0x8aa87a, hemiInt: 0.75,
    sunColor: 0xe8f0ff, sunInt: 0.9, sunPos: [-4, 9, 3],
    ground: 0xdde8e0, beamLayers: 0, beamWeight: 0,
    growthMod: 0, vignette: 0.22, night: 0, dusk: 0,
    quote: '下雪了，花园在休息。',
  },
  night: {  // 🌙 月夜·蓝调（20:00-06:00）
    label: '月夜 · 蓝调', icon: '🌙',
    overlay: { color: '#1A2038', alpha: 0.35 },
    particle: 'fireflies',
    sky: { hi: 0x3a4a6b, mid: 0x2a3552, lo: 0x1a2038 },
    fog: 0x232c48,
    hemiSky: 0x3a4a6b, hemiGround: 0x1a3514, hemiInt: 0.4,
    sunColor: 0x9fb4de, sunInt: 0.75, sunPos: [7, 8, -2],
    ground: 0x3d5c38, beamLayers: 2, beamWeight: 0.35,
    growthMod: 0, vignette: 0.35, night: 1, dusk: 0,
    quote: '好好睡，我守着花园。',
  },
};

// ── 天气计算引擎（§3.4 规则表，纯函数）────────────────────
// realWeather: 'sunny'|'cloudy'|'overcast'|'rain'|'snow'（演示版手动指定）
// userState: { deepSleepRatio, focusState: 'deep_focus'|'focus'|'distracted'|'tired'|'rest' }
export function computeWeather(realWeather, userState, hour = new Date().getHours()) {
  // 夜间优先级最高
  if (hour >= 20 || hour < 6) return 'night';
  if (realWeather === 'rain') return 'rain';
  if (realWeather === 'snow') return 'snow';
  if (realWeather === 'overcast') return 'overcast';
  if (realWeather === 'cloudy') return 'cloudy';
  // sunny：按身心状态分金色/灰调
  const tired = userState.focusState === 'tired' || userState.deepSleepRatio < 0.4;
  return tired ? 'sunny_gray' : 'sunny_gold';
}

// 演示用天气轮盘（展演手动切换）
export const WEATHER_ORDER = ['sunny_gold', 'cloudy', 'overcast', 'rain', 'snow', 'night'];
