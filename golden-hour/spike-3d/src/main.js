import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * 0. 确定性随机与模拟（20Hz 固定步长，渲染只读）
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 'GH-FIRE-0001';
const rng = mulberry32(0x9e3779b9);

const FLOORS = 6;
const FLOOR_H = 3;
const W = 26;
const D = 14;
const SIM_HZ = 20;
const DT = 1 / SIM_HZ;

const sim = {
  t: 0,
  running: true,
  fire: 0.12,
  smoke: new Float32Array(FLOORS),
  heat: new Float32Array(FLOORS),
  exposure: { smoke: 0, heat: 0, strain: 0 },
  crewFloor: 0,
  crewProgress: 0,
  doorOpen: false,
};

// 预埋事件：第 40 秒回燃门（Boss 点）
const EVENT_BACKDRAFT_AT = 40;

function stepSim(dt) {
  sim.t += dt;

  // 火势成长
  const growth = sim.t < EVENT_BACKDRAFT_AT ? 0.045 : 0.085;
  sim.fire = Math.min(1, sim.fire + growth * dt);

  // 一层起火，烟向上逐层填充（简化分区模型）
  sim.smoke[0] = clamp(sim.smoke[0] + (sim.fire * 0.62 - sim.smoke[0] * 0.22) * dt);
  for (let i = 1; i < FLOORS; i++) {
    const inflow = sim.smoke[i - 1] * 0.34;
    const outflow = sim.smoke[i] * (0.12 + i * 0.01);
    sim.smoke[i] = clamp(sim.smoke[i] + (inflow - outflow) * dt);
  }

  // 热负荷：贴近火源层最高
  for (let i = 0; i < FLOORS; i++) {
    const target = Math.max(0, sim.fire - i * 0.13) * 0.85;
    sim.heat[i] = clamp(sim.heat[i] + (target - sim.heat[i]) * dt * 0.5);
  }

  // 班组沿楼梯上行（演示用）
  sim.crewProgress += dt * 0.075;
  if (sim.crewProgress >= 1) {
    sim.crewProgress -= 1;
    sim.crewFloor = Math.min(FLOORS - 1, sim.crewFloor + 1);
  }

  // 暴露累积（烟气线完整，热与体力简化）
  const f = sim.crewFloor;
  const stray = sim.crewProgress > 0 ? 1.2 : 1;
  sim.exposure.smoke = clamp(sim.exposure.smoke + sim.smoke[f] * 0.055 * stray * dt * 10);
  sim.exposure.heat = clamp(sim.exposure.heat + sim.heat[f] * 0.022 * dt * 10);
  sim.exposure.strain = clamp(sim.exposure.strain + 0.006 * dt * 10);
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ *
 * 1. 渲染基础设施
 * ------------------------------------------------------------------ */

const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false; // 关键预算：关闭实时阴影
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f12);
scene.fog = new THREE.Fog(0x0d0f12, 60, 110);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
const FRUSTUM = 21;
camera.position.set(34, 30, 34);
camera.lookAt(0, 7.5, 0);

function resize() {
  const { innerWidth: w, innerHeight: h } = window;
  const aspect = w / h;
  camera.left = -FRUSTUM * aspect;
  camera.right = FRUSTUM * aspect;
  camera.top = FRUSTUM;
  camera.bottom = -FRUSTUM;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

/* ------------------------------------------------------------------ *
 * 2. 光与地面
 * ------------------------------------------------------------------ */

scene.add(new THREE.HemisphereLight(0x8fa3b8, 0x14181d, 1.15));

const key = new THREE.DirectionalLight(0xffe0c0, 1.25);
key.position.set(28, 42, 18);
scene.add(key);

const rim = new THREE.DirectionalLight(0x5a7fa8, 0.55);
rim.position.set(-24, 18, -26);
scene.add(rim);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(220, 220),
  new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.16;
scene.add(ground);

const grid = new THREE.GridHelper(220, 110, 0x2a3138, 0x1a2026);
grid.position.y = -0.15;
scene.add(grid);

/* ------------------------------------------------------------------ *
 * 3. 建筑（低多边形娃娃屋，前面剖开）
 * ------------------------------------------------------------------ */

const building = new THREE.Group();
scene.add(building);

const matSlab = new THREE.MeshStandardMaterial({ color: 0x3b424b, roughness: 0.95 });
const matWall = new THREE.MeshStandardMaterial({ color: 0x4a515a, roughness: 0.95 });
const matPart = new THREE.MeshStandardMaterial({ color: 0x565e68, roughness: 0.9 });
const matWarm = new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 0.9 });
const matDoor = new THREE.MeshStandardMaterial({
  color: 0x6b4a2c,
  roughness: 0.7,
  emissive: 0x341c08,
  emissiveIntensity: 0.6,
});

function box(w, h, d, mat, x, y, z, parent = building) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

for (let f = 0; f < FLOORS; f++) {
  const base = f * FLOOR_H;

  // 楼板
  box(W, 0.3, D, matSlab, 0, base, 0);

  // 后墙与两侧墙
  box(W, FLOOR_H, 0.3, matWall, 0, base + FLOOR_H / 2, -D / 2);
  box(0.3, FLOOR_H, D, matWall, -W / 2, base + FLOOR_H / 2, 0);
  box(0.3, FLOOR_H, D, matWall, W / 2, base + FLOOR_H / 2, 0);

  // 前立面只留柱，形成剖面
  for (let x = -W / 2; x <= W / 2; x += W / 4) {
    box(0.28, FLOOR_H, 0.28, matWall, x, base + FLOOR_H / 2, D / 2);
  }

  // 内隔墙
  const partitions = f % 2 === 0 ? [-7, 6] : [-3];
  for (const px of partitions) {
    box(0.2, FLOOR_H, D * 0.62, matPart, px, base + FLOOR_H / 2, -D * 0.19);
  }

  // 家具（确定性放置）
  for (let i = 0; i < 5; i++) {
    const fx = -W / 2 + 3 + rng() * (W - 6);
    const fz = -D / 2 + 2 + rng() * (D - 5);
    const s = 0.6 + rng() * 0.8;
    box(s * 1.6, s, s * 1.2, f % 3 === 0 ? matWarm : matPart, fx, base + s / 2, fz);
  }
}

// 屋顶：默认隐藏，便于俯视
const roof = box(W + 0.6, 0.35, D + 0.6, matSlab, 0, FLOORS * FLOOR_H, 0);
roof.visible = false;

// 楼梯间（竖向井道）
const stairMat = new THREE.MeshStandardMaterial({ color: 0x2f363e, roughness: 1 });
box(3.2, FLOORS * FLOOR_H, 3.2, stairMat, -9.5, (FLOORS * FLOOR_H) / 2, -4.2);

// 回燃门
const bossDoor = box(1.4, 2.1, 0.16, matDoor, 4.4, FLOOR_H + 1.05, D / 2 - 0.4);
bossDoor.name = 'boss-door';

// 火源：一层厨房
const fireLight = new THREE.PointLight(0xff7a2e, 0, 22, 2);
fireLight.position.set(-6, 1.4, 3.4);
scene.add(fireLight);

const flame = new THREE.Mesh(
  new THREE.ConeGeometry(0.9, 2.2, 7),
  new THREE.MeshBasicMaterial({ color: 0xff8a3c, transparent: true, opacity: 0.9 })
);
flame.position.set(-6, 1.2, 3.4);
scene.add(flame);

/* ------------------------------------------------------------------ *
 * 4. 烟：分层体积盒 + billboard 粒子
 * ------------------------------------------------------------------ */

const smokeGroup = new THREE.Group();
scene.add(smokeGroup);

const smokeBoxes = [];
for (let f = 0; f < FLOORS; f++) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x9aa3ad,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(W - 1.2, 1, D - 1.2), mat);
  m.position.set(0, f * FLOOR_H + 0.5, 0);
  smokeGroup.add(m);
  smokeBoxes.push(m);
}

// 烟粒子贴图（离线生成，不依赖外部资源）
function makeSmokeTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(220,225,232,0.85)');
  g.addColorStop(0.45, 'rgba(180,188,198,0.35)');
  g.addColorStop(1, 'rgba(150,158,170,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const smokeTex = makeSmokeTexture();
const puffs = [];
const PUFFS_PER_FLOOR = 7;
for (let f = 0; f < FLOORS; f++) {
  for (let i = 0; i < PUFFS_PER_FLOOR; i++) {
    const mat = new THREE.SpriteMaterial({
      map: smokeTex,
      color: 0xaab2bc,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    const baseX = -W / 2 + 2 + rng() * (W - 4);
    const baseZ = -D / 2 + 2 + rng() * (D - 4);
    s.position.set(baseX, f * FLOOR_H + rng() * FLOOR_H, baseZ);
    const scale = 1.6 + rng() * 1.8;
    s.scale.set(scale, scale, 1);
    s.userData = {
      floor: f,
      baseX,
      baseZ,
      speed: 0.35 + rng() * 0.5,
      phase: rng() * Math.PI * 2,
      scale,
    };
    smokeGroup.add(s);
    puffs.push(s);
  }
}

/* ------------------------------------------------------------------ *
 * 5. 人：InstancedMesh
 * ------------------------------------------------------------------ */

const AGENT_COUNT = 10;
const agentGeo = new THREE.CapsuleGeometry(0.24, 0.72, 3, 8);
const agentMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
const agents = new THREE.InstancedMesh(agentGeo, agentMat, AGENT_COUNT);
agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
agents.instanceColor = new THREE.InstancedBufferAttribute(
  new Float32Array(AGENT_COUNT * 3),
  3
);
scene.add(agents);

// 被困者分布：3 层老人、4 层儿童、5 层昏迷、天台 2 人
const agentData = [];
const layout = [
  { floor: 0, x: 6, z: 2, kind: 'crew' },
  { floor: 2, x: -4, z: 1, kind: 'elder' },
  { floor: 2, x: -1, z: 3, kind: 'elder' },
  { floor: 3, x: 3, z: -2, kind: 'child' },
  { floor: 3, x: 5, z: 1, kind: 'child' },
  { floor: 4, x: -6, z: 2, kind: 'unconscious' },
  { floor: 5, x: 0, z: 3, kind: 'roof' },
  { floor: 5, x: 4, z: 3, kind: 'roof' },
  { floor: 1, x: 8, z: -3, kind: 'civilian' },
  { floor: 0, x: -8, z: 3, kind: 'crew' },
];
const COLOR = {
  crew: new THREE.Color(0x5fa88a),
  elder: new THREE.Color(0xd9c27a),
  child: new THREE.Color(0x7fb2d9),
  unconscious: new THREE.Color(0xd24b3f),
  roof: new THREE.Color(0xcfd4da),
  civilian: new THREE.Color(0x8b93a0),
};

for (let i = 0; i < AGENT_COUNT; i++) {
  const spec = layout[i];
  agentData.push({ ...spec, ox: spec.x, oz: spec.z });
  const c = COLOR[spec.kind] || COLOR.civilian;
  agents.setColorAt(i, c);
}
agents.instanceColor.needsUpdate = true;

const dummy = new THREE.Object3D();

function updateAgents(time) {
  for (let i = 0; i < AGENT_COUNT; i++) {
    const a = agentData[i];
    let x = a.ox;
    let z = a.oz;
    let y = a.floor * FLOOR_H + 0.55;

    if (a.kind === 'crew') {
      // 演示：班组沿楼梯井上行
      const f = Math.min(FLOORS - 1, sim.crewFloor + (i === 0 ? 0 : 0));
      y = f * FLOOR_H + 0.55 + sim.crewProgress * FLOOR_H;
      x = -9.5 + Math.sin((time + i) * 0.7) * 0.5;
      z = -4.2 + Math.cos((time + i) * 0.6) * 0.5;
    } else {
      // 被困者轻微呼吸/晃动
      const breath = Math.sin(time * 1.4 + i * 1.7) * 0.02;
      y += a.kind === 'unconscious' ? -0.3 : breath;
      x += Math.sin(time * 0.5 + i) * 0.06;
      z += Math.cos(time * 0.45 + i) * 0.06;
    }

    dummy.position.set(x, y + 0.36, z);
    dummy.rotation.y = (i * 1.7) % (Math.PI * 2);
    dummy.updateMatrix();
    agents.setMatrixAt(i, dummy.matrix);
  }
  agents.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------------ *
 * 6. HUD
 * ------------------------------------------------------------------ */

const el = {
  fps: document.getElementById('fps'),
  calls: document.getElementById('calls'),
  tris: document.getElementById('tris'),
  time: document.getElementById('time'),
  seed: document.getElementById('seed'),
  exSmoke: document.getElementById('ex-smoke'),
  exHeat: document.getElementById('ex-heat'),
  exStrain: document.getElementById('ex-strain'),
  floorRows: document.getElementById('floor-rows'),
};
el.seed.textContent = `seed ${SEED}`;

const floorBars = [];
for (let f = FLOORS - 1; f >= 0; f--) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${f + 1}F</label><div class="bar"><i></i></div>`;
  el.floorRows.appendChild(row);
  floorBars[f] = row.querySelector('i');
}

function setBar(node, value, warnAt = 0.45, dangerAt = 0.72) {
  node.style.width = `${Math.round(value * 100)}%`;
  node.classList.toggle('warn', value >= warnAt && value < dangerAt);
  node.classList.toggle('danger', value >= dangerAt);
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function updateHud(fps) {
  el.fps.textContent = fps.toFixed(0);
  el.calls.textContent = String(renderer.info.render.calls);
  el.tris.textContent = renderer.info.render.triangles.toLocaleString('en-US');
  el.time.textContent = fmt(sim.t);
  setBar(el.exSmoke, sim.exposure.smoke);
  setBar(el.exHeat, sim.exposure.heat);
  setBar(el.exStrain, sim.exposure.strain, 0.6, 0.85);
  for (let f = 0; f < FLOORS; f++) setBar(floorBars[f], sim.smoke[f]);
}

/* ------------------------------------------------------------------ *
 * 7. 控制
 * ------------------------------------------------------------------ */

let cutaway = true;
let smokeVisible = true;

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC') {
    cutaway = !cutaway;
    // 剖开时隐藏前柱，完整视图时恢复
    // （spike 中用屋顶与烟层透明度演示）
    roof.visible = !cutaway;
  }
  if (e.code === 'KeyS') {
    smokeVisible = !smokeVisible;
    smokeGroup.visible = smokeVisible;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    sim.running = !sim.running;
  }
});

/* ------------------------------------------------------------------ *
 * 8. 主循环
 * ------------------------------------------------------------------ */

let acc = 0;
let last = performance.now();
let fpsAvg = 60;
let hudTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);

  const rawDt = Math.min((now - last) / 1000, 0.25);
  last = now;
  fpsAvg = fpsAvg * 0.92 + (1 / Math.max(rawDt, 1e-4)) * 0.08;

  if (sim.running) {
    acc += rawDt;
    while (acc >= DT) {
      stepSim(DT);
      acc -= DT;
    }
  }

  const time = now / 1000;

  // 火与光
  const flicker = 0.85 + Math.sin(time * 13.7) * 0.08 + Math.sin(time * 7.1) * 0.05;
  flame.scale.set(1, 0.75 + sim.fire * 0.9, 1);
  flame.material.opacity = 0.55 + sim.fire * 0.4;
  fireLight.intensity = sim.fire * 22 * flicker;

  // 回燃门预警：临近事件时脉冲
  const near = 1 - Math.min(1, Math.abs(sim.t - EVENT_BACKDRAFT_AT) / 12);
  bossDoor.material.emissiveIntensity = 0.5 + near * (2.2 + Math.sin(time * 9) * 1.2);

  // 烟层盒
  for (let f = 0; f < FLOORS; f++) {
    const s = sim.smoke[f];
    const m = smokeBoxes[f];
    const h = Math.max(0.02, s * (FLOOR_H - 0.5));
    m.scale.y = h;
    m.position.y = f * FLOOR_H + h / 2 + 0.15;
    m.material.opacity = s * 0.34;
  }

  // 烟粒子
  for (const p of puffs) {
    const d = p.userData;
    const s = sim.smoke[d.floor];
    const t = time * d.speed + d.phase;
    p.position.y = d.floor * FLOOR_H + 0.5 + ((t % 1) * (FLOOR_H - 0.6));
    p.position.x = d.baseX + Math.sin(t * 1.3) * 0.5;
    p.position.z = d.baseZ + Math.cos(t * 1.1) * 0.5;
    p.material.opacity = s * 0.55;
    const sc = d.scale * (0.8 + (t % 1) * 0.7);
    p.scale.set(sc, sc, 1);
  }

  updateAgents(time);
  renderer.render(scene, camera);

  hudTimer += rawDt;
  if (hudTimer > 0.2) {
    hudTimer = 0;
    updateHud(fpsAvg);
  }
}

requestAnimationFrame(frame);

// 便于自动化验收
window.__spike = {
  sim,
  renderer,
  get stats() {
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps: fpsAvg,
      smoke: Array.from(sim.smoke).map((v) => +v.toFixed(3)),
    };
  },
};
