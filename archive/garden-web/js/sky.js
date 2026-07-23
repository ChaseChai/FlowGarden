// 镜园 FlowGarden · L1 天空与光照层（v2.0 塞尚块面版 §3.2 / §3.5）
// 天空 = 大块多边形面片层叠，每面纯色（无渐变）
// 光束 = 逐级增亮的硬边多边形层叠（5 层，核心视觉签名）

import * as THREE from 'three';

// 多边形天空：低分段球体 → 按高度带赋予三块面色，每面附手绘抖动
function buildPolygonSky() {
  let geo = new THREE.SphereGeometry(60, 9, 6);
  geo = geo.toNonIndexed();
  const pos = geo.attributes.position;
  const faceCount = pos.count / 3;
  const colors = new Float32Array(pos.count * 3);
  const band = new Uint8Array(faceCount);   // 0=lo 1=mid 2=hi
  const jitter = new Float32Array(faceCount);

  for (let f = 0; f < faceCount; f++) {
    const y = (pos.getY(f * 3) + pos.getY(f * 3 + 1) + pos.getY(f * 3 + 2)) / 3;
    const h = y / 60; // -1..1
    band[f] = h > 0.34 ? 2 : h > 0.05 ? 1 : 0;
    jitter[f] = 0.94 + Math.random() * 0.10; // 色块间微差，"一笔一笔画出来"的感觉
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return { geo, band, jitter, faceCount };
}

// 梯形多边形（光束截面：上宽下窄）
function trapezoidGeometry(topW, bottomW, h) {
  const shape = new THREE.Shape();
  shape.moveTo(-topW / 2, h / 2);
  shape.lineTo(topW / 2, h / 2);
  shape.lineTo(bottomW / 2, -h / 2);
  shape.lineTo(-bottomW / 2, -h / 2);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

export class Sky {
  constructor(scene) {
    // ── 多边形天空 ─────────────────────────────
    const sky = buildPolygonSky();
    this.skyGeo = sky.geo;
    this.skyBand = sky.band;
    this.skyJitter = sky.jitter;
    this.skyFaceCount = sky.faceCount;
    // 三块面色（gsap 直接 tween 这些 Color）
    this.bandColors = [
      new THREE.Color(0xa8b8c8), // lo
      new THREE.Color(0xc9d5e0), // mid
      new THREE.Color(0xe8e0d5), // hi
    ];
    const skyMat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    const skyMesh = new THREE.Mesh(this.skyGeo, skyMat);
    skyMesh.frustumCulled = false;
    scene.add(skyMesh);
    this._repaintSky();

    // ── 硬边层叠光束（5 层多边形，逐级增亮）────────
    // 层色随状态 5 级色阶走：核心 L5 最亮 → 外缘 L2
    this.beamCols = [
      new THREE.Color(0xfaf7f2), new THREE.Color(0xf2ede4),
      new THREE.Color(0xddd5c5), new THREE.Color(0xc8bda8),
      new THREE.Color(0xc8bda8),
    ];
    this.beamBaseOpacity = [0.9, 0.62, 0.45, 0.32, 0.22];
    this.beamLevel = { value: 0 };   // 可见层数 0..5（gsap tween）
    this.beamWeight = { value: 0 };  // 整体强度 0..1（gsap tween）

    this.beamLayers = [];
    this.beamGroup = new THREE.Group();
    const beamLen = 26;
    const shaftX = [-2.6, -0.2, 2.0];
    for (let s = 0; s < shaftX.length; s++) {
      for (let i = 4; i >= 0; i--) { // 外→内 依次叠加
        const w = 1.0 + i * 0.55;
        const geo = trapezoidGeometry(w * 1.5, w * 0.7, beamLen);
        const mat = new THREE.MeshBasicMaterial({
          color: this.beamCols[i], transparent: true, opacity: 0,
          depthWrite: false, fog: false, side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(shaftX[s], 6.5, -7 - s * 0.4 - i * 0.02);
        mesh.userData.layer = i;
        this.beamGroup.add(mesh);
        this.beamLayers.push(mesh);
      }
    }
    this.beamGroup.rotation.z = -0.5; // 左上→右下 30-45°（§3.5）
    scene.add(this.beamGroup);

    // ── 多边形月亮 + 硬边光晕 ─────────────────────
    this.moonGroup = new THREE.Group();
    this.moonHaloMats = [0.22, 0.1].map(o => new THREE.MeshBasicMaterial({
      color: 0xd6e2ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    const halo1 = new THREE.Mesh(new THREE.CircleGeometry(3.6, 10), this.moonHaloMats[0]);
    const halo2 = new THREE.Mesh(new THREE.CircleGeometry(5.6, 10), this.moonHaloMats[1]);
    this.moonMat = new THREE.MeshBasicMaterial({
      color: 0xf4f1e8, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    const moon = new THREE.Mesh(new THREE.CircleGeometry(1.5, 10), this.moonMat);
    halo2.position.z = -0.2; halo1.position.z = -0.1;
    this.moonGroup.add(halo2, halo1, moon);
    this.moonGroup.position.set(7.5, 7.8, -20);
    scene.add(this.moonGroup);

    // ── 星星（硬边小方块）────────────────────────
    const starTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 16;
      c.getContext('2d').fillStyle = '#EAF0FF';
      c.getContext('2d').fillRect(4, 4, 8, 8);
      return new THREE.CanvasTexture(c);
    })();
    const starCount = 300;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const r = 40 + Math.random() * 10;
      starPos[i * 3] = Math.cos(theta) * r;
      starPos[i * 3 + 1] = 3 + Math.random() * 32;
      starPos[i * 3 + 2] = Math.sin(theta) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      map: starTex, color: 0xeaf0ff, size: 0.16, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false, fog: false, alphaTest: 0.1,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    // ── 黄昏多边形落日（疲惫状态）──────────────────
    this.duskMats = [0xf0c8a0, 0xe8a76a, 0xd4784a].map(c => new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    this.duskGroup = new THREE.Group();
    const duskHalo2 = new THREE.Mesh(new THREE.CircleGeometry(4.6, 8), this.duskMats[2]);
    const duskHalo1 = new THREE.Mesh(new THREE.CircleGeometry(3.1, 8), this.duskMats[1]);
    const duskSun = new THREE.Mesh(new THREE.CircleGeometry(1.9, 8), this.duskMats[0]);
    duskHalo2.position.z = -0.2; duskHalo1.position.z = -0.1;
    this.duskGroup.add(duskHalo2, duskHalo1, duskSun);
    this.duskGroup.position.set(-8.5, 2.0, -18);
    scene.add(this.duskGroup);

    // 状态权重（main.js gsap 驱动）
    this.night = { value: 0 };
    this.duskW = { value: 0 };
  }

  // 按三块面色重绘天空顶点色
  _repaintSky() {
    const colAttr = this.skyGeo.attributes.color;
    const tmp = new THREE.Color();
    for (let f = 0; f < this.skyFaceCount; f++) {
      tmp.copy(this.bandColors[this.skyBand[f]]).multiplyScalar(this.skyJitter[f]);
      colAttr.setXYZ(f * 3, tmp.r, tmp.g, tmp.b);
      colAttr.setXYZ(f * 3 + 1, tmp.r, tmp.g, tmp.b);
      colAttr.setXYZ(f * 3 + 2, tmp.r, tmp.g, tmp.b);
    }
    colAttr.needsUpdate = true;
  }

  update(t) {
    this._repaintSky(); // 80 面 × 3 顶点，逐帧重绘成本可忽略，保证 tween 生效

    // 光束：层数 × 整体强度，逐层硬边出现
    const level = this.beamLevel.value, weight = this.beamWeight.value;
    for (const layer of this.beamLayers) {
      const i = layer.userData.layer;
      const on = Math.min(Math.max(level - i, 0), 1); // 第 i 层是否点亮
      layer.material.opacity = this.beamBaseOpacity[i] * on * weight;
    }

    const n = this.night.value;
    this.moonMat.opacity = 0.96 * n;
    // 月光呼吸：~4s 周期（数据轴占位，后续接 IMU 体动）
    const breathe = 0.5 + 0.5 * Math.sin(t * (Math.PI / 2));
    this.moonHaloMats[0].opacity = (0.16 + 0.10 * breathe) * n;
    this.moonHaloMats[1].opacity = (0.07 + 0.05 * breathe) * n;
    this.starMat.opacity = 0.9 * n;
    this.stars.rotation.y = t * 0.004;

    const d = this.duskW.value;
    this.duskMats[0].opacity = 0.95 * d;
    this.duskMats[1].opacity = 0.4 * d;
    this.duskMats[2].opacity = 0.2 * d;
  }
}
