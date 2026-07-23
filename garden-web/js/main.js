// 镜园 FlowGarden · 主入口 v4（俯瞰式算法花园，设计指南 v3.0 §3）
// 渲染管线：L1 网格地面 → L2 天气粒子 → L3 植物网格 → L4 专注轨迹 → L5 天气覆盖 → L6 UI
// 数据管线：用户数据 → gardenAlgo 规则引擎 → 布局生成 → 生长速率 → 植物网格
// 现阶段全部本地算力；gardenAlgo/weather 为纯函数模块，未来可直接迁移云服务器。

import * as THREE from 'three';
import { Sky } from './sky.js';
import { ParticleField } from './particles.js';
import { PlantField } from './plants.js';
import { evaluateGardenRules, generateLayout, generateTrapline, GRID } from './gardenAlgo.js';
import { WEATHERS, computeWeather, WEATHER_ORDER } from './weather.js';
import { Workbench } from './workbench.js';

// ── 演示用户数据（未来来自戒指→bridge→云端）────────────────
const USER_DATA = {
  deepSleepRatio: 0.58, focusDeepRatio: 0.45,
  streakDays: 3, totalFocusHours: 6, distractionCount: 0,
};
const DEMO_SPEED = 2.0;          // 展演生长加速倍率
const AUTO_WEATHER = true;       // 初始按时段/状态自动计算天气

// ── 渲染器 / 场景 ─────────────────────────────────────────
const canvas = document.getElementById('garden');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 300);

// 斜 45° 俯瞰（§3.3）：base 位 + 拖拽 ±15° + 滚轮缩放 0.8-2x
const CAM_BASE = new THREE.Vector3(0, 13.2, 16.8);
const CAM_TARGET = new THREE.Vector3(0, 0.4, 0);
let camRotY = 0, camRotTarget = 0, camZoom = 1, camZoomTarget = 1;
function updateCamera() {
  camRotY += (camRotTarget - camRotY) * 0.08;
  camZoom += (camZoomTarget - camZoom) * 0.1;
  const p = CAM_BASE.clone().multiplyScalar(camZoom);
  const cos = Math.cos(camRotY), sin = Math.sin(camRotY);
  camera.position.set(p.x * cos + p.z * sin, p.y, -p.x * sin + p.z * cos);
  camera.lookAt(CAM_TARGET);
}
updateCamera();

// 拖拽旋转 ±15° / 滚轮缩放（保持"地图感"，非自由旋转）
let dragging = false, dragX = 0;
canvas.addEventListener('pointerdown', e => { dragging = true; dragX = e.clientX; });
window.addEventListener('pointermove', e => {
  if (!dragging) return;
  camRotTarget = THREE.MathUtils.clamp(camRotTarget + (e.clientX - dragX) * 0.002, -0.26, 0.26);
  dragX = e.clientX;
});
window.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('wheel', e => {
  camZoomTarget = THREE.MathUtils.clamp(camZoomTarget + e.deltaY * 0.0008, 0.8, 2);
}, { passive: true });

// ── 算法花园：规则引擎 → 布局（§3.10）─────────────────────
const rules = evaluateGardenRules(USER_DATA);
const layout = generateLayout(rules, 20260723);

// ── L1 地面层：暖调大地色块 + 花园床 + 网格线 + 锁定区块 ────
const groundMat = new THREE.MeshStandardMaterial({ color: 0x9cc06f, roughness: 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 花园床（暖大地色，与草地色差分块）
const bedMat = new THREE.MeshStandardMaterial({ color: 0xc9a86f, roughness: 1 });
const bed = new THREE.Mesh(new THREE.PlaneGeometry(GRID.width + 0.7, GRID.height + 0.7), bedMat);
bed.rotation.x = -Math.PI / 2;
bed.position.y = 0.015;
bed.receiveShadow = true;
scene.add(bed);

// 网格线（硬边诚实：深色细线）
{
  const pts = [];
  const hw = GRID.width / 2, hh = GRID.height / 2;
  for (let c = 0; c <= GRID.COLS; c++) {
    const x = -hw + c * GRID.CELL;
    pts.push(x, 0.03, -hh, x, 0.03, hh);
  }
  for (let r = 0; r <= GRID.ROWS; r++) {
    const z = -hh + r * GRID.CELL;
    pts.push(-hw, 0.03, z, hw, 0.03, z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8a6f4a, transparent: true, opacity: 0.5 })));
}

// 锁定区块覆盖（未解锁 = 深色硬边遮罩，§3.10.2 规则5）
const lockGroup = new THREE.Group();
scene.add(lockGroup);
{
  const zoneCells = {};
  for (const cell of layout.cells) {
    if (cell.unlocked) continue;
    (zoneCells[cell.zone] = zoneCells[cell.zone] || []).push(cell);
  }
  for (const cells of Object.values(zoneCells)) {
    const cols = cells.map(c => c.col), rows = cells.map(c => c.row);
    const c0 = Math.min(...cols), c1 = Math.max(...cols), r0 = Math.min(...rows), r1 = Math.max(...rows);
    const w0 = GRID.toWorld(c0, r0), w1 = GRID.toWorld(c1, r1);
    const lock = new THREE.Mesh(
      new THREE.PlaneGeometry(w1.x - w0.x + GRID.CELL, w1.z - w0.z + GRID.CELL),
      new THREE.MeshBasicMaterial({ color: 0x4a4238, transparent: true, opacity: 0.42 })
    );
    lock.rotation.x = -Math.PI / 2;
    lock.position.set((w0.x + w1.x) / 2, 0.04, (w0.z + w1.z) / 2);
    lockGroup.add(lock);
  }
}

// ── L4 专注轨迹（§3.10.4 Focus Traplines）──────────────────
{
  const pts = generateTrapline(7);
  const verts = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < pts.length; i++) {
    const dir = i < pts.length - 1
      ? new THREE.Vector3(pts[i + 1].x - pts[i].x, 0, pts[i + 1].z - pts[i].z).normalize()
      : new THREE.Vector3(pts[i].x - pts[i - 1].x, 0, pts[i].z - pts[i - 1].z).normalize();
    const side = new THREE.Vector3().crossVectors(dir, up).multiplyScalar(0.14 + pts[i].depth * 0.3);
    verts.push(pts[i].x - side.x, 0.05, pts[i].z - side.z, pts[i].x + side.x, 0.05, pts[i].z + side.z);
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  const trap = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color: 0xf5d76e, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
  }));
  scene.add(trap);
}

// ── L0-L3 层 ─────────────────────────────────────────────
const sky = new Sky(scene);
const particles = new ParticleField(scene);
const plants = new PlantField(scene).build(layout, { rareSpawn: rules.rareSpawnToday, seed: 42 });

// 光照（天气引擎驱动）
const hemi = new THREE.HemisphereLight(0xf2d5a3, 0x6da85d, 0.62);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe9b0, 2.0);
sun.position.set(-6, 10, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12; sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -12;
sun.shadow.bias = -0.001;
scene.add(sun);
scene.fog = new THREE.Fog(0xddb984, 24, 68);

// Nexi 占位（花园边缘，L0 数字人未来 Live2D 替换）
const nexi = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 0.9, 5),
    new THREE.MeshStandardMaterial({ color: 0xc9a5d6, flatShading: true, roughness: 0.7 })
  );
  body.position.y = 0.45; body.castShadow = true;
  const head = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.2, 0),
    new THREE.MeshStandardMaterial({ color: 0xf7d0d8, flatShading: true, roughness: 0.7 })
  );
  head.position.y = 1.05; head.castShadow = true;
  nexi.add(body, head);
  nexi.position.set(GRID.width / 2 + 1.2, 0, GRID.height / 2 - 1.5);
  scene.add(nexi);
}

// ── L5 天气覆盖层（DOM）───────────────────────────────────
const overlay = document.createElement('div');
overlay.id = 'weatherOverlay';
document.body.appendChild(overlay);

// ── 天气应用 ─────────────────────────────────────────────
const gsap = window.gsap;
let currentWeather = null;
const particleTargets = { pollen: 0, drift: 0, leaves: 0, fireflies: 0, dust: 0, rain: 0, snow: 0 };

function applyWeather(id, instant = false) {
  if (id === currentWeather) return;
  currentWeather = id;
  const w = WEATHERS[id];
  const dur = instant ? 0 : 2.2;
  const tween = (colorObj, hex) => {
    const c = new THREE.Color(hex);
    gsap.to(colorObj, { r: c.r, g: c.g, b: c.b, duration: dur, ease: 'power2.inOut' });
  };

  // 天空三块面色（bandColors: [0]=lo [1]=mid [2]=hi）
  tween(sky.bandColors[0], w.sky.lo);
  tween(sky.bandColors[1], w.sky.mid);
  tween(sky.bandColors[2], w.sky.hi);
  tween(scene.fog.color, w.fog);
  tween(hemi.color, w.hemiSky);
  tween(hemi.groundColor, w.hemiGround);
  gsap.to(hemi, { intensity: w.hemiInt, duration: dur });
  tween(sun.color, w.sunColor);
  gsap.to(sun, { intensity: w.sunInt, duration: dur });
  gsap.to(sun.position, { x: w.sunPos[0], y: w.sunPos[1], z: w.sunPos[2], duration: dur });
  gsap.to(sky.beamLevel, { value: w.beamLayers, duration: dur, ease: 'power2.inOut' });
  gsap.to(sky.beamWeight, { value: w.beamWeight, duration: dur });
  gsap.to(sky.night, { value: w.night, duration: dur });
  gsap.to(sky.duskW, { value: w.dusk, duration: dur });
  gsap.to('#vignette', { opacity: 0.4 + w.vignette, duration: dur });

  // 地面/花园床色
  tween(groundMat.color, w.ground);
  const bedC = new THREE.Color(w.ground).offsetHSL(0, 0.06, 0.09);
  gsap.to(bedMat.color, { r: bedC.r, g: bedC.g, b: bedC.b, duration: dur });

  // 粒子切换（权重直接 gsap 渐变）
  for (const k of Object.keys(particleTargets)) particleTargets[k] = 0;
  particleTargets[w.particle] = 1;
  gsap.to(particles.weights, { ...particleTargets, duration: dur });

  // L5 覆盖层
  gsap.to(overlay, {
    backgroundColor: w.overlay.color, opacity: w.overlay.alpha,
    duration: dur,
  });

  // UI 天气卡片
  document.getElementById('weatherIcon').textContent = w.icon;
  document.getElementById('weatherLabel').textContent = w.label;
  nexiSay(w.quote);
}

// ── UI ───────────────────────────────────────────────────
const nexiText = document.getElementById('nexiText');
const toast = document.getElementById('stateToast');
let toastTimer = null;
function nexiSay(text) {
  nexiText.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3400);
}

// 身心状态按钮 → 影响天气计算输入 + 分心暂停代价
const STATE_LINES = {
  deep_focus: '心流中——花园在加速生长。',
  focus: '你专心，我在这里。',
  distracted: '没关系，我们继续。',
  tired: '今天我们都有点累，慢慢来。',
  rest: '好好休息，我守着花园。',
};
let focusState = 'focus';
let pauseTimer = 0;   // 规则4：分心代价 = 生长暂停（不逆转）

document.querySelectorAll('#stateBar button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('#stateBar button.active')?.classList.remove('active');
    btn.classList.add('active');
    focusState = btn.dataset.state;
    if (focusState === 'distracted') {
      pauseTimer += 8;   // 演示：8s 暂停（真实规则 10 min）
      nexiSay('分心标记——花园生长暂停片刻，但长出的不会消失。');
    } else {
      nexiSay(STATE_LINES[focusState]);
    }
    if (AUTO_WEATHER) {
      applyWeather(computeWeather(currentRealWeather, { deepSleepRatio: USER_DATA.deepSleepRatio, focusState }));
    }
  });
});

// 天气轮盘按钮（展演手动切换）
let currentRealWeather = 'sunny';
let weatherIdx = 0;
document.getElementById('weatherBtn').addEventListener('click', () => {
  weatherIdx = (weatherIdx + 1) % WEATHER_ORDER.length;
  applyWeather(WEATHER_ORDER[weatherIdx]);
});

// "Create new garden"（§3.10.5）：Pollinator 式重新生成——新色带布局
let gardenSeed = 20260723;
document.getElementById('btn-seed').addEventListener('click', () => {
  gardenSeed = (gardenSeed * 9301 + 49297) % 233280;
  const newLayout = generateLayout(rules, gardenSeed);
  plants.build(newLayout, { rareSpawn: rules.rareSpawnToday, seed: gardenSeed });
  nexiSay('算法重新规划了花园——色带换了走向，为你的状态而设计。');
});

// ── 专注模式工作台（§11）：花园退为情绪背景 ────────────────
const workbench = new Workbench({
  onExit: (focusTime) => nexiSay(`专注 ${focusTime}，辛苦了。花园又长大了一点。`),
  onPlantsToday: () => plants.cells.filter(c => c.stage >= 3).length,
});
document.getElementById('btn-focus-mode').addEventListener('click', () => workbench.enter());

// 初始天气：真实晴 + 时段/身心自动计算
applyWeather(computeWeather('sunny', { deepSleepRatio: USER_DATA.deepSleepRatio, focusState }), true);
weatherIdx = WEATHER_ORDER.indexOf(currentWeather);

// HUD 时钟 + 规则参数
const clockEl = document.getElementById('hudClock');
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
tickClock(); setInterval(tickClock, 10000);
document.getElementById('hudRules').textContent =
  `密度 ${(rules.density * 100) | 0}% · 生长 ${(rules.growthRate * 100) | 0}% · 稀有花 ${(rules.rareProb * 100) | 0}% · 区块 ${rules.unlockedZones.length}/9`;

// ── 主循环 ───────────────────────────────────────────────
document.getElementById('loader')?.remove();
window.__garden = { renderer, scene, camera, plants, sky, particles, applyWeather, WEATHERS, rules };   // 展演调试钩子
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  const w = WEATHERS[currentWeather];
  let rate = rules.growthRate * w.growthMod * DEMO_SPEED;
  if (pauseTimer > 0) { pauseTimer -= dt; rate = 0; }
  if (focusState === 'tired') rate *= 0.6;
  if (focusState === 'deep_focus') rate *= 1.4;

  updateCamera();
  sky.update(t);
  plants.update(t, dt, rate);
  particles.update(t);
  workbench.tick(dt);
  nexi.position.y = Math.sin(t * 1.1) * 0.03;
  nexi.rotation.y = Math.sin(t * 0.6) * 0.12;

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
