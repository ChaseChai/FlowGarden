// 镜园 FlowGarden · L3 几何粒子层（v2.0 塞尚块面版 §3.2）
// 硬边小块粒子：金色小三角 ◆ / 白色小方块 ■ / 棕色碎片 ◢ / 黄绿六边形 / 暗色微块
// 运动逻辑沿用 v1 shader（上升/漂浮/落叶/游走/微尘），纹理全部改为硬边几何形

import * as THREE from 'three';

function makeTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  return new THREE.CanvasTexture(c);
}

// 金色小三角 ◆：亮面 #FFF8E1 顶角 + 主体 #F5D76E（双折面）
const triangleTex = () => makeTex(64, (ctx, s) => {
  ctx.fillStyle = '#F5D76E';
  ctx.beginPath(); ctx.moveTo(s / 2, 6); ctx.lineTo(s - 8, s - 8); ctx.lineTo(8, s - 8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#FFF8E1';
  ctx.beginPath(); ctx.moveTo(s / 2, 6); ctx.lineTo(s / 2 + 12, s - 20); ctx.lineTo(s / 2 - 12, s - 20); ctx.closePath(); ctx.fill();
});

// 白色小方块 ■：#EEEEEE + 一级暗边
const squareTex = () => makeTex(64, (ctx, s) => {
  ctx.fillStyle = '#EEEEEE'; ctx.fillRect(12, 12, s - 24, s - 24);
  ctx.fillStyle = '#DDD5C5'; ctx.fillRect(12, s - 20, s - 24, 8);
});

// 棕色碎片 ◢：不规则四边形，#D4954B / #C1783A 双折面
const shardTex = () => makeTex(64, (ctx, s) => {
  ctx.fillStyle = '#C1783A';
  ctx.beginPath(); ctx.moveTo(10, 16); ctx.lineTo(s - 14, 8); ctx.lineTo(s - 8, s - 12); ctx.lineTo(16, s - 8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#D4954B';
  ctx.beginPath(); ctx.moveTo(10, 16); ctx.lineTo(s - 14, 8); ctx.lineTo(s / 2, s / 2); ctx.closePath(); ctx.fill();
});

// 黄绿六边形（萤火虫）：#D4F54A + 上半亮面 #E8FF8A
const hexTex = () => makeTex(64, (ctx, s) => {
  const cx = s / 2, cy = s / 2, r = 22;
  ctx.fillStyle = '#D4F54A';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
            : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#E8FF8A';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.87, cy - r * 0.5); ctx.lineTo(cx, cy - r); ctx.lineTo(cx + r * 0.87, cy - r * 0.5); ctx.lineTo(cx, cy);
  ctx.closePath(); ctx.fill();
});

// 暗色微块（疲惫微尘）：#B8553A 小方块
const dustTex = () => makeTex(64, (ctx, s) => {
  ctx.fillStyle = '#8B5A3A'; ctx.fillRect(22, 22, 20, 20);
  ctx.fillStyle = '#B87A5A'; ctx.fillRect(22, 22, 20, 7);
});

// 雨滴 ◢：硬边蓝色小斜条（§3.4 雨·冷蓝）
const rainTex = () => makeTex(32, (ctx, s) => {
  ctx.fillStyle = '#8AA8D8';
  ctx.beginPath();
  ctx.moveTo(s / 2 - 2, 3); ctx.lineTo(s / 2 + 3, 3);
  ctx.lineTo(s / 2 + 1, s - 3); ctx.lineTo(s / 2 - 4, s - 3);
  ctx.closePath(); ctx.fill();
});

// 雪花 ❖：硬边白色六角形（§3.4 雪·白）
const snowTex = () => makeTex(64, (ctx, s) => {
  const cx = s / 2, cy = s / 2, r = 18;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
            : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#DCE8F8';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.87, cy + r * 0.5); ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx + r * 0.87, cy + r * 0.5); ctx.lineTo(cx, cy);
  ctx.closePath(); ctx.fill();
});

// 统一 fragment：纹理色 × 单面旋转
const FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uWeight;
  varying float vAlpha;
  varying float vAngle;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vAngle), sn = sin(vAngle);
    uv = mat2(c, -sn, sn, c) * uv;
    uv = clamp(uv + 0.5, 0.0, 1.0);
    vec4 tex = texture2D(uMap, uv);
    float a = tex.a * vAlpha * uWeight;
    if (a < 0.02) discard;
    gl_FragColor = vec4(tex.rgb, a);
  }`;

const VERT_HEAD = /* glsl */`
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  varying float vAlpha;
  varying float vAngle;
`;

// 金色小三角：缓慢上升 + 微旋转（深度心流）
const VERT_POLLEN = VERT_HEAD + /* glsl */`
  void main() {
    vec3 p = position;
    float rise = 0.22 + 0.12 * fract(aSeed * 5.1);
    p.y = 0.2 + mod(position.y + uTime * rise + aSeed * 4.0, 4.2);
    p.x += sin(uTime * 0.5 + aSeed * 6.283) * 0.5;
    p.z += cos(uTime * 0.35 + aSeed * 4.7) * 0.3;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (140.0 / -mv.z) * (0.7 + 0.6 * fract(aSeed * 7.7));
    vAngle = uTime * (0.4 + 0.4 * fract(aSeed * 3.3)) + aSeed * 6.283;
    vAlpha = 0.5 + 0.5 * (0.5 + 0.5 * sin(uTime * 1.3 + aSeed * 6.283));
  }`;

// 白色小方块：水平漂浮 + 缓慢翻转（浅度专注）
const VERT_DRIFT = VERT_HEAD + /* glsl */`
  void main() {
    vec3 p = position;
    float speed = 0.30 + 0.20 * fract(aSeed * 3.3);
    p.x = mod(position.x + uTime * speed + aSeed * 10.0, 16.0) - 8.0;
    p.y = position.y + sin(uTime * 0.6 + aSeed * 6.283) * 0.35;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (140.0 / -mv.z) * (0.6 + 0.7 * fract(aSeed * 6.1));
    vAngle = uTime * 0.3 + aSeed * 6.283;
    vAlpha = 0.22 + 0.3 * (0.5 + 0.5 * sin(uTime * 0.9 + aSeed * 6.283));
  }`;

// 棕色碎片：旋转下坠 + 左右飘荡，10s 后自动停止（分心标记）
const VERT_LEAF = /* glsl */`
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform float uFallStart;
  varying float vAlpha;
  varying float vAngle;
  void main() {
    float delay = aSeed * 2.5;
    float fallT = clamp(uTime - uFallStart - delay, 0.0, 8.0);
    float live = step(0.001, uTime - uFallStart - delay);
    float speed = 0.28 + 0.15 * fract(aSeed * 3.7);
    float groundY = 0.03 + fract(aSeed * 9.3) * 0.05;
    float tLand = (position.y - groundY) / (speed * 2.2);
    float effT = min(fallT, tLand);
    vec3 p = position;
    p.y = position.y - effT * speed * 2.2;
    p.x += sin(effT * 1.8 + aSeed * 6.28) * 0.45;
    p.z += cos(effT * 1.3 + aSeed * 4.0) * 0.20;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (140.0 / -mv.z) * (0.7 + 0.6 * fract(aSeed * 5.5));
    vAngle = effT * (2.0 + aSeed * 2.0) + aSeed * 6.28;
    vAlpha = live * smoothstep(0.0, 0.2, fallT) * (1.0 - smoothstep(6.5, 8.0, fallT));
  }`;

// 黄绿六边形：随机游走 + 呼吸式明暗（月夜萤火虫）
const VERT_FIREFLY = VERT_HEAD + /* glsl */`
  void main() {
    vec3 p = position;
    float f1 = 0.31 + 0.20 * fract(aSeed * 3.3);
    p.x += sin(uTime * f1 + aSeed * 6.28) * 1.4 + sin(uTime * 0.83 + aSeed * 3.0) * 0.5;
    p.y += sin(uTime * (0.5 + 0.3 * fract(aSeed * 5.7)) + aSeed * 4.0) * 0.6;
    p.z += cos(uTime * (0.27 + 0.15 * fract(aSeed * 7.1)) + aSeed * 2.0) * 0.8;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (140.0 / -mv.z) * (0.7 + 0.6 * fract(aSeed * 8.3));
    vAngle = aSeed * 6.283;
    float blink = smoothstep(0.2, 0.9, 0.5 + 0.5 * sin(uTime * (1.5 + fract(aSeed * 9.1)) + aSeed * 6.28));
    vAlpha = 0.25 + 0.75 * blink;
  }`;

// 暗色微块：极慢飘浮（疲惫）
const VERT_DUST = VERT_HEAD + /* glsl */`
  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.12 + aSeed * 6.28) * 0.4;
    p.y += sin(uTime * 0.09 + aSeed * 3.1) * 0.25;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (140.0 / -mv.z);
    vAngle = aSeed * 6.283;
    vAlpha = 0.3 + 0.3 * (0.5 + 0.5 * sin(uTime * 0.8 + aSeed * 6.283));
  }`;

// 雨滴 ◢：快速斜落循环（§3.4 雨·冷蓝）
const VERT_RAIN = VERT_HEAD + /* glsl */`
  void main() {
    vec3 p = position;
    float fall = 6.5 + 3.5 * fract(aSeed * 5.1);
    p.y = 6.0 - mod(position.y + uTime * fall + aSeed * 6.0, 7.0);
    p.x = mod(position.x + (6.0 - p.y) * 0.22 + 8.0, 16.0) - 8.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (140.0 / -mv.z);
    vAngle = -0.28;
    vAlpha = 0.5 + 0.3 * fract(aSeed * 3.3);
  }`;

// 雪花 ❖：慢落 + 左右飘移 + 自旋（§3.4 雪·白）
const VERT_SNOW = VERT_HEAD + /* glsl */`
  void main() {
    vec3 p = position;
    float fall = 0.5 + 0.3 * fract(aSeed * 3.7);
    p.y = 5.5 - mod(position.y + uTime * fall + aSeed * 5.0, 6.0);
    p.x += sin(uTime * 0.7 + aSeed * 6.283) * 0.55;
    p.z += cos(uTime * 0.5 + aSeed * 4.0) * 0.35;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (140.0 / -mv.z) * (0.6 + 0.7 * fract(aSeed * 6.1));
    vAngle = uTime * (0.4 + 0.5 * fract(aSeed * 4.4)) + aSeed * 6.283;
    vAlpha = 0.7 + 0.3 * sin(uTime * 1.1 + aSeed * 6.283);
  }`;

function makePoints(count, box) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = box.x[0] + Math.random() * (box.x[1] - box.x[0]);
    pos[i * 3 + 1] = box.y[0] + Math.random() * (box.y[1] - box.y[0]);
    pos[i * 3 + 2] = box.z[0] + Math.random() * (box.z[1] - box.z[0]);
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  return geo;
}

export class ParticleField {
  constructor(scene) {
    this.weights = { pollen: 0, drift: 0, leaves: 0, fireflies: 0, dust: 0, rain: 0, snow: 0 };
    this.systems = {};

    const defs = {
      pollen: {
        count: 240, box: { x: [-6.5, 6.5], y: [0.2, 4.2], z: [-3.5, 2.5] },
        vert: VERT_POLLEN, size: 1.9, map: triangleTex(),
      },
      drift: {
        count: 120, box: { x: [-8, 8], y: [0.6, 3.6], z: [-4, 3] },
        vert: VERT_DRIFT, size: 1.25, map: squareTex(),
      },
      leaves: {
        count: 70, box: { x: [-5, 5], y: [2.2, 3.6], z: [-2, 2] },
        vert: VERT_LEAF, size: 5.2, map: shardTex(),
      },
      fireflies: {
        count: 90, box: { x: [-6, 6], y: [0.25, 2.2], z: [-3, 2] },
        vert: VERT_FIREFLY, size: 1.6, map: hexTex(),
      },
      dust: {
        count: 130, box: { x: [-6, 6], y: [0.2, 3.2], z: [-3, 2.5] },
        vert: VERT_DUST, size: 1.1, map: dustTex(),
      },
      rain: {
        count: 260, box: { x: [-8, 8], y: [0, 6], z: [-4, 3] },
        vert: VERT_RAIN, size: 2.3, map: rainTex(),
      },
      snow: {
        count: 200, box: { x: [-8, 8], y: [0, 5.5], z: [-4, 3] },
        vert: VERT_SNOW, size: 1.8, map: snowTex(),
      },
    };

    for (const [name, d] of Object.entries(defs)) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: d.size },
          uWeight: { value: 0 },
          uMap: { value: d.map },
          uFallStart: { value: -999 },
        },
        vertexShader: d.vert,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      });
      const points = new THREE.Points(makePoints(d.count, d.box), mat);
      points.frustumCulled = false;
      scene.add(points);
      this.systems[name] = points;
    }
  }

  // 拍击诚实标记 → 一轮碎片飘落（屏幕回应 <200ms，§8.3）
  triggerLeaves(t) {
    this.systems.leaves.material.uniforms.uFallStart.value = t;
  }

  update(t) {
    for (const [name, points] of Object.entries(this.systems)) {
      points.material.uniforms.uTime.value = t;
      points.material.uniforms.uWeight.value = this.weights[name];
    }
  }
}
