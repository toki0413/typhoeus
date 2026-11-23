import type { BuildingGraph } from '../sim/spatial/rooms';
import type { ScenarioSnapshot } from '../sim/spatial/scene';

export interface BuildingView {
  sync(
    graph: BuildingGraph,
    snapshot: ScenarioSnapshot,
    currentRoom: string,
    targetRoom: string,
    routeLinks: string[]
  ): void;
  render(): void;
  resize(): void;
  roomAt(px: number, py: number): string | null;
}

const BASE = [23, 28, 34] as const;

function roomColor(fire: number, smoke: number, heat: number): string {
  const f = Math.min(1, fire * 6);
  const s = Math.min(1, smoke);
  const h = Math.min(1, heat);
  const r = Math.min(255, BASE[0] + 232 * f + 90 * h + 40 * s);
  const g = Math.min(255, BASE[1] + 94 * f + 20 * h + 40 * s);
  const b = Math.min(255, BASE[2] + 4 * f + 10 * h + 50 * s);
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

export function createBuildingView(canvas: HTMLCanvasElement): BuildingView {
  const ctx = canvas.getContext('2d');
  let rects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  let centers: Record<string, { x: number; y: number }> = {};

  function resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }

  resize();
  window.addEventListener('resize', resize);

  function sync(
    graph: BuildingGraph,
    snapshot: ScenarioSnapshot,
    currentRoom: string,
    targetRoom: string,
    routeLinks: string[]
  ): void {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0a0c0f';
    ctx.fillRect(0, 0, w, h);

    const floors = [3, 2, 1, 0];
    const rowH = h / floors.length;
    const pad = 10;
    rects = [];
    centers = {};
    const routeSet = new Set(routeLinks);

    floors.forEach((floor, row) => {
      const ids = Object.keys(graph.rooms)
        .filter((id) => graph.rooms[id].floor === floor)
        .sort((a, b) => graph.rooms[a].bounds.x - graph.rooms[b].bounds.x);
      const colW = w / Math.max(1, ids.length);

      ids.forEach((id, col) => {
        const x = col * colW + pad;
        const y = row * rowH + pad;
        const cw = colW - pad * 2;
        const ch = rowH - pad * 2;
        rects.push({ id, x, y, w: cw, h: ch });
        centers[id] = { x: x + cw / 2, y: y + ch / 2 };

        const s = snapshot.rooms[id];
        ctx.fillStyle = roomColor(s.fire, s.smoke, s.heat);
        ctx.fillRect(x, y, cw, ch);

        ctx.strokeStyle = id === currentRoom ? '#e5b567' : '#2a323c';
        ctx.lineWidth = id === currentRoom ? 3 : 1;
        ctx.strokeRect(x, y, cw, ch);

        ctx.fillStyle = '#f2efe9';
        ctx.font = `${Math.max(10, Math.min(14, cw * 0.12))}px system-ui, sans-serif`;
        ctx.fillText(id, x + 8, y + 18);
        ctx.fillStyle = '#9aa3ad';
        ctx.font = `${Math.max(9, Math.min(12, cw * 0.1))}px ui-monospace, monospace`;
        ctx.fillText(`火 ${Math.round(s.fire * 100)}% · 烟 ${Math.round(s.smoke * 100)}%`, x + 8, y + 34);
      });
    });

    for (const link of graph.links) {
      const a = centers[link.a];
      const b = centers[link.b];
      if (!a || !b) continue;
      const active = routeSet.has(link.id);
      ctx.strokeStyle = link.blocked ? '#5a2a2a' : active ? '#e5b567' : '#2a323c';
      ctx.lineWidth = active ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const player = centers[currentRoom];
    if (player) {
      ctx.beginPath();
      ctx.fillStyle = '#3f6f5c';
      ctx.arc(player.x, player.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e5b567';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (!snapshot.occupant.rescued) {
      const target = centers[targetRoom];
      if (target) {
        ctx.beginPath();
        ctx.fillStyle = '#c39a7f';
        ctx.arc(target.x + 14, target.y + 10, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function render(): void {}

  function roomAt(px: number, py: number): string | null {
    const dpr = canvas.width / (canvas.clientWidth || window.innerWidth);
    const x = px * dpr;
    const y = py * dpr;
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    return null;
  }

  return { sync, render, resize, roomAt };
}
