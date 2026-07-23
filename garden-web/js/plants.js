// 镜园 FlowGarden · 植物网格层 v4（设计指南 v3.0 §3.2/§3.5/§4）
// 由 gardenAlgo.generateLayout() 驱动：Pollinator 式色带布局 × 硬边低多边形花毯。
// - 16×12 网格，每格一株，物种来自植物调色板（球/碟/钟/穗 4 花形 + 极光兰）
// - 生长阶段：种子→芽(6s)→株(18s)→花(45s)（演示加速，真实规则 5/30/120 min，§3.5）
// - 分心暂停、天气生长修正由 main.js 以 rate 传入；长出的植物永不消失（滋养非惩罚）
// - 渲染范式：InstancedMesh 单次 drawcall/层 + flatShading + 顶点着色器摇曳

import * as THREE from 'three';
import { PLANT_PALETTE, GRID } from './gardenAlgo.js';

// 叶/茎色阶（§4.4 花草A/B/C 亮面→暗面）
const LEAF_HI = [0xa8d08d, 0xb4d89a, 0xc5d8a0];
const LEAF_MID = [0x6da85d, 0x72a85d, 0x85a858];
const LEAF_LO = [0x4e8a3e, 0x558a40, 0x628a3c];
const STEM_COLORS = [0x5a8a45, 0x4e8a3e, 0x628a3c];
const SEED_COLOR = 0x8b6b4a;
// 花头顶点色 = 近白微差（顶点色×实例色是相乘关系，白色让实例花色真实呈现）
const WHITE_FACES = [0xffffff, 0xfaf5ec, 0xf2ecdf];

// 生长阈值（演示秒 ≈ 真实分钟 ×10 加速）
const T_SPROUT = 6, T_PLANT = 18, T_FLOWER = 45;

const TIME_U = { value: 0 };   // 全场共享时钟

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 硬边面着色 + 顶点摇曳材质（花毯范式：CPU 零动画开销）
function paintSway(geo, palette, uWind, rng) {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let f = 0; f < count / 3; f++) {
    c.set(palette[Math.floor(rng() * palette.length)]);
    for (let v = 0; v < 3; v++) {
      colors[(f * 3 + v) * 3] = c.r;
      colors[(f * 3 + v) * 3 + 1] = c.g;
      colors[(f * 3 + v) * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TIME_U;
    shader.uniforms.uWind = uWind;
    shader.vertexShader = `
      uniform float uTime; uniform float uWind;
      attribute float aPhase; attribute float aHgt;
    ` + shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        float iPh = aPhase; float iH = aHgt;
      #else
        float iPh = 0.0; float iH = 0.0;
      #endif
      float wAmp = smoothstep(0.02, 0.55, position.y) * uWind;
      transformed.x += sin(uTime * 1.25 + iPh) * 0.045 * wAmp;
      transformed.z += cos(uTime * 0.95 + iPh * 1.4) * 0.038 * wAmp;
      transformed.y += sin(uTime * 1.6 + iPh * 2.0) * 0.008 * wAmp * iH;
    `);
  };
  return mat;
}

// 花头几何：一花一形（"不同花型适配不同状态"）
function headGeometry(shape) {
  switch (shape) {
    case 'disc': { const g = new THREE.DodecahedronGeometry(1, 0); g.scale(1, 0.45, 1); return g; }
    case 'bell': return new THREE.ConeGeometry(1, 1.3, 6);
    case 'spike': return new THREE.OctahedronGeometry(1, 0);
    case 'orchid': { const g = new THREE.IcosahedronGeometry(1, 0); g.scale(0.8, 1.35, 0.8); return g; }
    case 'ball':
    default: return new THREE.IcosahedronGeometry(1, 0);
  }
}

function addInstAttrs(mesh, list, hgtFn, rng) {
  const n = list.length;
  const phases = new Float32Array(n);
  const hgts = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    phases[i] = rng() * Math.PI * 2;
    hgts[i] = hgtFn(list[i]);
  }
  mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  mesh.geometry.setAttribute('aHgt', new THREE.InstancedBufferAttribute(hgts, 1));
}

export class PlantField {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.uWind = { value: 1 };
    this.cells = [];           // 种植格（含生长计时）
    this.meshes = {};
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    scene.add(this.group);
  }

  // 清空已建网格（"Create new garden" 重新生成前调用）
  dispose() {
    for (const key of Object.keys(this.meshes)) {
      const m = this.meshes[key];
      if (!m) continue;   // 空花形组 mk() 返回 null，跳过
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.meshes = {};
    this.cells = [];
    this.grass = [];
  }

  // layout: generateLayout() 输出；rareSpawn: 今日是否诞生极光兰
  build(layout, { rareSpawn = false, seed = 42 } = {}) {
    this.dispose();
    const rng = mulberry(seed);
    const planted = layout.cells.filter(c => c.planted);

    // 极光兰：从已种植格中挑一株升格（稀有花是"巅峰体验"的见证）
    if (rareSpawn && planted.length) {
      const pick = planted[Math.floor(rng() * planted.length)];
      pick.species = 'rare_s';
    }

    this.cells = planted.map((cell, i) => {
      const sp = PLANT_PALETTE[cell.species];
      const w = GRID.toWorld(cell.col, cell.row);
      return {
        ...cell, sp, i,
        x: w.x + cell.jitterX, z: w.z + cell.jitterZ,
        h: (sp.height[0] + rng() * (sp.height[1] - sp.height[0])) * (cell.tall ? 1.45 : 1),
        size: (sp.size[0] + rng() * (sp.size[1] - sp.size[0])) * cell.sizeK,
        color: sp.colors[Math.floor(rng() * sp.colors.length)],
        t: rng() * 14,          // 初始生长进度错开（stagger）
        pop: 0, stage: -1,
      };
    });

    // ── 分层建 InstancedMesh ─────────────────────────────
    const byShape = { ball: [], disc: [], bell: [], spike: [], orchid: [] };
    for (const c of this.cells) byShape[c.sp.shape === 'orchid' ? 'orchid' : c.sp.shape].push(c);

    // instColor：true 时写入实例花色（仅花头；茎/叶/种子保持顶点色，避免双层色相乘发暗）
    const mk = (geo, palette, list, { emissive = 0, hgtFn = c => c.h, instColor = false } = {}) => {
      if (!list.length) return null;
      const g = geo.clone();
      const mat = paintSway(g, palette, this.uWind, rng);
      if (emissive) { mat.emissive = new THREE.Color(emissive); mat.emissiveIntensity = 0.4; }
      const mesh = new THREE.InstancedMesh(g, mat, list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      addInstAttrs(mesh, list, hgtFn, rng);
      mesh.frustumCulled = false;
      if (instColor) {
        // 实例花色：调色板内逐株微差
        const col = new THREE.Color();
        list.forEach((c, i) => {
          col.set(c.color).offsetHSL((rng() - 0.5) * 0.02, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.06);
          mesh.setColorAt(i, col);
        });
      }
      this.group.add(mesh);
      return mesh;
    };

    // 茎：细三棱柱
    const stemGeo = new THREE.CylinderGeometry(0.5, 0.72, 1, 3, 1);
    stemGeo.translate(0, 0.5, 0);
    this.meshes.stem = mk(stemGeo, STEM_COLORS, this.cells, { hgtFn: c => c.h });

    // 花头：按花形分组（spike 三段穗 = 3 倍实例，段序 = 株序×3）
    // 白色顶点色 + 实例花色（花朵是规则引擎的"数据表达"，色相必须真实）
    for (const shape of ['ball', 'disc', 'bell', 'orchid']) {
      const list = byShape[shape];
      this.meshes[shape] = mk(headGeometry(shape), WHITE_FACES, list, {
        emissive: shape === 'orchid' ? 0xf5c842 : 0,
        hgtFn: c => c.h + 0.1,
        instColor: true,
      });
      list.forEach((c, i) => { c.headMesh = this.meshes[shape]; c.headIdx = i; });
    }
    const spikeList = [];
    byShape.spike.forEach((c, j) => {
      spikeList.push(c, c, c);
      c.headMesh = null; c.headIdx = j * 3;   // spike 走专用分支
    });
    this.meshes.spike = mk(headGeometry('spike'), WHITE_FACES, spikeList, { hgtFn: c => c.h + 0.2, instColor: true });

    // 叶：宽扁二十面体，每株 1-2 片
    const leafGeo = new THREE.IcosahedronGeometry(1, 0);
    leafGeo.scale(1, 0.22, 1);
    this.meshes.leaf1 = mk(leafGeo, LEAF_MID, this.cells, { hgtFn: c => c.h * 0.4 });
    this.cells.forEach((c, i) => { c.leaf1Idx = i; });
    const leaf2List = this.cells.filter(() => rng() < 0.7);
    this.meshes.leaf2 = mk(leafGeo, LEAF_HI, leaf2List, { hgtFn: c => c.h * 0.6 });
    leaf2List.forEach((c, i) => { c.leaf2Idx = i; });

    // 种子：小多面体土堆（阶段 0 可见）
    const seedGeo = new THREE.DodecahedronGeometry(1, 0);
    this.meshes.seed = mk(seedGeo, [SEED_COLOR], this.cells, { hgtFn: () => 0 });

    // 草：铺在未种植空格 + 色带间隙（§3.10.3 "草种提供栖息地"）
    const grassCells = layout.cells.filter(c => c.unlocked && !c.planted && rng() < 0.8);
    const bladeGeo = new THREE.ConeGeometry(0.5, 1, 4, 1);
    bladeGeo.translate(0, 0.5, 0);
    this.grass = [];
    if (grassCells.length) {
      const g = bladeGeo.clone();
      const mat = paintSway(g, WHITE_FACES, this.uWind, rng);   // 顶点近白，草色走实例色
      const per = 2;
      const mesh = new THREE.InstancedMesh(g, mat, grassCells.length * per);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      const phases = new Float32Array(grassCells.length * per);
      const hgts = new Float32Array(grassCells.length * per);
      const col = new THREE.Color();
      let gi = 0;
      for (const cell of grassCells) {
        const w = GRID.toWorld(cell.col, cell.row);
        for (let k = 0; k < per; k++) {
          const gx = w.x + (rng() - 0.5) * 0.7, gz = w.z + (rng() - 0.5) * 0.7;
          const gh = 0.1 + rng() * 0.13;
          this.grass.push({ x: gx, z: gz, h: gh, rot: rng() * Math.PI * 2, i: gi });
          phases[gi] = rng() * Math.PI * 2; hgts[gi] = gh;
          col.set(LEAF_MID[Math.floor(rng() * 3)]).offsetHSL(0, 0, (rng() - 0.5) * 0.1);
          mesh.setColorAt(gi, col);
          gi++;
        }
      }
      mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
      mesh.geometry.setAttribute('aHgt', new THREE.InstancedBufferAttribute(hgts, 1));
      this.group.add(mesh);
      this.meshes.grass = mesh;
      this._writeGrass(0);
    }

    return this;
  }

  _set(mesh, i, x, y, z, sx, sy, sz, rotY = 0) {
    this._e.set(0, rotY, 0);
    this._q.setFromEuler(this._e);
    this._v.set(x, y, z);
    this._s.set(sx, sy, sz);
    this._m4.compose(this._v, this._q, this._s);
    mesh.setMatrixAt(i, this._m4);
  }

  _writeGrass(t) {
    if (!this.meshes.grass) return;
    for (const g of this.grass) {
      this._set(this.meshes.grass, g.i, g.x, 0, g.z, 0.05, g.h, 0.05, g.rot);
    }
    this.meshes.grass.instanceMatrix.needsUpdate = true;
  }

  // rate = 规则引擎 growthRate × 天气修正 × 分心暂停（0=暂停）
  update(t, dt, rate = 1) {
    TIME_U.value = t;
    const M = this.meshes;
    if (!M.stem) return;

    for (const c of this.cells) {
      c.t += dt * rate;
      c.pop = Math.max(0, c.pop - dt * 2.2);
      const stage = c.t >= T_FLOWER ? 3 : c.t >= T_PLANT ? 2 : c.t >= T_SPROUT ? 1 : 0;
      if (stage !== c.stage) { c.stage = stage; c.pop = 1; }   // 阶段跃迁 → 破土/绽放弹跳
      const popK = 1 + c.pop * 0.55;
      const isRare = c.sp.shape === 'orchid';

      // 种子（仅阶段 0）
      const seedS = stage === 0 ? 0.075 * (1 + Math.sin(t * 3 + c.i) * 0.08) : 0.0001;
      this._set(M.seed, c.i, c.x, 0.02, c.z, seedS, seedS * 0.8, seedS, c.rot);

      // 茎（阶段 ≥2 长出）
      const stemK = stage >= 2 ? Math.min(1, (c.t - T_PLANT) / 6 + 0.3) : 0.001;
      this._set(M.stem, c.i, c.x, 0, c.z, 0.055 * popK, c.h * stemK, 0.055 * popK, c.rot);

      // 叶（阶段 1 贴地小芽 → 阶段 ≥2 沿茎展开）
      const leafS = stage === 0 ? 0.0001 : (stage === 1 ? 0.09 : 0.16 * c.size) * popK;
      const leafY = stage === 1 ? 0.05 : c.h * 0.38 * stemK;
      this._set(M.leaf1, c.leaf1Idx, c.x + 0.05, leafY, c.z, leafS, leafS, leafS, c.rot + 0.6);
      if (c.leaf2Idx !== undefined) {
        this._set(M.leaf2, c.leaf2Idx, c.x - 0.05, stage === 1 ? 0.04 : c.h * 0.62 * stemK, c.z + 0.03,
          leafS * 0.8, leafS * 0.8, leafS * 0.8, c.rot - 0.9);
      }

      // 花头（阶段 3 绽放；极光兰持续呼吸发光）
      const headBase = stage >= 3 ? 0.16 * c.size * popK : 0.0001;
      if (c.sp.shape === 'spike') {
        // 穗状：三段八面体沿茎叠放，向上渐小
        for (let k = 0; k < 3; k++) {
          const segS = headBase * (1 - k * 0.24);
          this._set(M.spike, c.headIdx + k, c.x, c.h * stemK + 0.05 + k * 0.13 * c.size, c.z,
            segS, segS * 1.35, segS, c.rot + k * 0.5);
        }
      } else if (c.headMesh) {
        const breathe = isRare ? 1 + Math.sin(t * 1.5 + c.i) * 0.06 : 1;
        this._set(c.headMesh, c.headIdx, c.x, c.h * stemK + 0.08, c.z,
          headBase * breathe, headBase * (c.sp.shape === 'disc' ? 0.8 : breathe), headBase * breathe, c.rot);
      }
    }

    for (const key of Object.keys(M)) if (M[key]) M[key].instanceMatrix.needsUpdate = true;
    if (M.orchid) M.orchid.material.emissiveIntensity = 0.32 + Math.sin(t * 1.5) * 0.12;
  }

  setWind(w) { this.uWind.value = w; }
}
