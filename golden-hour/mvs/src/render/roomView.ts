import * as THREE from 'three';
import { CELL_SIZE, clamp01, type RoomState } from '../sim/spatial/fields';
import { ROOM_SIZE_M, worldToGrid, gridToWorld } from '../sim/spatial/coords';

/**
 * 单房间切片的俯视渲染：地板按场值着色，烟层高度表示浓度，
 * 门/窗按开合状态摆动，火源用点光。只负责画面，不碰模拟。
 */
export interface RoomView {
  sync(
    state: RoomState,
    actor: { x: number; z: number },
    dt: number,
    occupant?: { x: number; z: number; rescued: boolean }
  ): void;
  render(): void;
  resize(): void;
  worldToGrid(wx: number, wz: number): { x: number; y: number };
  gridToWorld(x: number, y: number): { x: number; z: number };
  readonly size: number;
}

const COLORS = {
  base: new THREE.Color(0x171c22),
  hot: new THREE.Color(0xb63a12),
  fire: new THREE.Color(0xff7a1a),
  smoke: new THREE.Color(0x4a4f55),
  water: new THREE.Color(0x2a6296),
  steam: new THREE.Color(0xbfc7cf),
};

export function createRoomView(canvas: HTMLCanvasElement): RoomView {
  const size = ROOM_SIZE_M;
  const cellSize = CELL_SIZE;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    // 沙盒/无 GPU 环境：退回 Canvas2D 俯视图，模拟与操作仍可玩。
    return createFallbackView(canvas, size, worldToGrid, gridToWorld);
  }

  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c0f);
  scene.fog = new THREE.Fog(0x0a0c0f, 10, 20);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 60);
  camera.position.set(0, 8.2, 8.6);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0x6b7a8c, 0x0c0f13, 0.9));
  const key = new THREE.DirectionalLight(0xffe3b8, 1.1);
  key.position.set(5, 9, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  // 地板网格
  const floorCells: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  const cols = 8;
  const rows = 8;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const geo = new THREE.PlaneGeometry(cellSize * 0.97, cellSize * 0.97);
      const mat = new THREE.MeshBasicMaterial({ color: COLORS.base.clone() });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((x + 0.5) * cellSize - size / 2, 0.012, (y + 0.5) * cellSize - size / 2);
      scene.add(mesh);
      floorCells.push(mesh);
    }
  }

  // 地板底
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // 四面墙，门在左中、窗在右中，用不同材质的小段表现开口
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: 0.9 });
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x5a4630, roughness: 0.8 });
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x8fb6cc,
    roughness: 0.2,
    transparent: true,
    opacity: 0.35,
  });

  const wallH = 2.6;
  const makeWall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };

  // 上下两面整墙
  makeWall(size + 0.3, wallH, 0.15, 0, wallH / 2, -size / 2);
  makeWall(size + 0.3, wallH, 0.15, 0, wallH / 2, size / 2);

  // 左右墙分段，中间留 1.1m 的开口
  const gap = 1.2;
  for (const side of [-1, 1]) {
    const seg = (size - gap) / 2;
    makeWall(0.15, wallH, seg, side * (size / 2), wallH / 2, -(gap / 2 + seg / 2));
    makeWall(0.15, wallH, seg, side * (size / 2), wallH / 2, gap / 2 + seg / 2);
  }

  const door = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.05, gap * 0.92), doorMat);
  door.position.set(-size / 2, 1.025, 0);
  door.castShadow = true;
  scene.add(door);

  const windowPane = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.3, gap * 0.92), windowMat);
  windowPane.position.set(size / 2, 1.4, 0);
  scene.add(windowPane);

  // 家具：沙发（A 类燃料）与油桶（B 类）
  const sofaMat = new THREE.MeshStandardMaterial({ color: 0x4a3b34, roughness: 0.95 });
  const sofa = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.4), sofaMat);
  sofa.position.set(1.65, 0.25, 0.4);
  sofa.castShadow = true;
  scene.add(sofa);

  const oilMat = new THREE.MeshStandardMaterial({ color: 0x3c4a3a, metalness: 0.4, roughness: 0.5 });
  const oil = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.62, 14), oilMat);
  oil.position.set(-1.45, 0.31, 1.05);
  oil.castShadow = true;
  scene.add(oil);

  // 烟层：一个半透明盒子，高度和透明度随烟浓度
  const smokeMat = new THREE.MeshBasicMaterial({
    color: 0x9aa3ad,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const smokeBox = new THREE.Mesh(new THREE.BoxGeometry(size - 0.2, 1, size - 0.2), smokeMat);
  smokeBox.position.y = 2;
  scene.add(smokeBox);

  // 火源光
  const fireLight = new THREE.PointLight(0xff6a1a, 0, 9, 2);
  fireLight.position.set(1.6, 1.2, 0.4);
  scene.add(fireLight);

  // 玩家
  const player = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.24, 0.7, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x3f6f5c, roughness: 0.75 })
  );
  body.position.y = 0.72;
  body.castShadow = true;
  player.add(body);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xd6ab45, roughness: 0.4 })
  );
  helmet.position.y = 1.42;
  helmet.castShadow = true;
  player.add(helmet);
  scene.add(player);

  // 被困居民：侧躺的胶囊体
  const occupantMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.2, 0.75, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x9c6b58, roughness: 0.85 })
  );
  occupantMesh.rotation.z = Math.PI / 2;
  occupantMesh.position.y = 0.22;
  occupantMesh.castShadow = true;
  scene.add(occupantMesh);

  function sync(
    state: RoomState,
    p: { x: number; z: number },
    _dt: number,
    occupant?: { x: number; z: number; rescued: boolean }
  ): void {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = state.cells[y * cols + x];
        const mesh = floorCells[y * cols + x];
        const color = COLORS.base.clone();
        color.lerp(COLORS.hot, clamp01(cell.heat * 0.8));
        color.lerp(COLORS.fire, clamp01(cell.fire * 1.1));
        color.lerp(COLORS.smoke, clamp01(cell.smoke * 0.55));
        color.lerp(COLORS.water, clamp01(cell.water * 0.65));
        color.lerp(COLORS.steam, clamp01(cell.steam * 0.5));
        mesh.material.color.copy(color);
      }
    }

    let smokeAvg = 0;
    let fireAvg = 0;
    for (const cell of state.cells) {
      smokeAvg += cell.smoke;
      fireAvg += cell.fire;
    }
    smokeAvg /= state.cells.length;
    fireAvg /= state.cells.length;

    const smokeHeight = 0.5 + smokeAvg * 1.9;
    smokeBox.scale.y = smokeHeight;
    smokeBox.position.y = smokeHeight / 2;
    smokeMat.opacity = clamp01(smokeAvg * 0.55);

    fireLight.intensity = clamp01(fireAvg * 6);

    door.rotation.y = state.openings.door.open || state.openings.door.broken ? -1.35 : 0;
    windowPane.visible = !state.openings.window.open && !state.openings.window.broken;

    player.position.set(p.x, 0, p.z);

    occupantMesh.visible = !!occupant && !occupant.rescued;
    if (occupant && !occupant.rescued) {
      occupantMesh.position.set(occupant.x, 0.22, occupant.z);
    }
  }

  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  resize();
  window.addEventListener('resize', resize);

  function render(): void {
    renderer.render(scene, camera);
  }

  return { sync, render, resize, worldToGrid, gridToWorld, size };
}

const FALLBACK_BASE = [23, 28, 34] as const;

function cellColor(c: {
  heat: number;
  fire: number;
  smoke: number;
  water: number;
  steam: number;
}): string {
  const heat = clamp01(c.heat) * 0.8;
  const fire = clamp01(c.fire) * 1.1;
  const smoke = clamp01(c.smoke) * 0.35;
  const water = clamp01(c.water) * 0.5;
  const steam = clamp01(c.steam) * 0.5;
  const base = FALLBACK_BASE;
  let r = Math.min(255, base[0] + 159 * heat + 232 * fire + 51 * smoke + 19 * water);
  let g = Math.max(0, Math.min(255, base[1] + 30 * heat + 94 * fire + 51 * smoke + 70 * water));
  let b = Math.max(0, Math.min(255, base[2] + 4 * heat + 4 * fire + 51 * smoke + 116 * water));
  r += (191 - r) * steam;
  g += (199 - g) * steam;
  b += (207 - b) * steam;
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/** 无 WebGL 时的俯视 2D 渲染：网格颜色 + 门/窗 + 玩家。 */
function createFallbackView(
  canvas: HTMLCanvasElement,
  size: number,
  worldToGrid: (wx: number, wz: number) => { x: number; y: number },
  gridToWorld: (x: number, y: number) => { x: number; z: number }
): RoomView {
  const ctx = canvas.getContext('2d');
  let dpr = 1;

  function resize(): void {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }

  resize();
  window.addEventListener('resize', resize);

  function sync(
    state: RoomState,
    player: { x: number; z: number },
    _dt?: number,
    occupant?: { x: number; z: number; rescued: boolean }
  ): void {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0a0c0f';
    ctx.fillRect(0, 0, w, h);

    const board = Math.min(w, h) * 0.86;
    const originX = (w - board) / 2;
    const originY = (h - board) / 2;
    const cell = board / state.config.cols;

    for (let y = 0; y < state.config.rows; y++) {
      for (let x = 0; x < state.config.cols; x++) {
        const c = state.cells[y * state.config.cols + x];
        ctx.fillStyle = cellColor(c);
        ctx.fillRect(originX + x * cell + 1, originY + y * cell + 1, cell - 2, cell - 2);
      }
    }

    // 门 / 窗
    const midY = originY + (state.config.rows / 2) * cell;
    ctx.fillStyle = state.openings.door.open || state.openings.door.broken ? '#6fbf9a' : '#e5b567';
    ctx.fillRect(originX - 6, midY - cell * 0.4, 6, cell * 0.8);
    ctx.fillStyle = state.openings.window.open || state.openings.window.broken ? '#6fbf9a' : '#8fb6cc';
    ctx.fillRect(originX + board, midY - cell * 0.4, 6, cell * 0.8);

    // 玩家
    const px = originX + ((player.x + size / 2) / size) * board;
    const py = originY + ((player.z + size / 2) / size) * board;
    ctx.beginPath();
    ctx.fillStyle = '#3f6f5c';
    ctx.arc(px, py, cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e5b567';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 被困居民（未救出时显示）
    if (occupant && !occupant.rescued) {
      const ox = originX + ((occupant.x + size / 2) / size) * board;
      const oy = originY + ((occupant.z + size / 2) / size) * board;
      ctx.beginPath();
      ctx.fillStyle = '#c39a7f';
      ctx.arc(ox, oy, cell * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }

    // 烟层整体
    let smoke = 0;
    for (const c of state.cells) smoke += c.smoke;
    smoke /= state.cells.length;
    ctx.fillStyle = `rgba(154,163,173,${Math.min(0.45, smoke * 0.35)})`;
    ctx.fillRect(originX, originY, board, board);
  }

  return {
    sync,
    render() {},
    resize,
    worldToGrid,
    gridToWorld,
    size,
  };
}
