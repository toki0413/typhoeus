import type { ActorState } from '../spatial/actor';
import type { BuildingGraph, RoomLink } from '../spatial/rooms';

export interface Route {
  steps: RoomLink[];
  time: number;
  risk: number;
  score: number;
}

export function canTraverse(link: RoomLink, actor: ActorState): boolean {
  if (link.blocked) return false;
  if (link.kind === 'ladder') return actor.load < 0.7 && actor.stamina > 0.25;
  if (link.kind === 'window') return actor.load < 0.6;
  return true;
}

function dijkstra(
  graph: BuildingGraph,
  from: string,
  to: string,
  banned: Set<string>,
  actor: ActorState
): Route | null {
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, RoomLink>();
  const visited = new Set<string>();
  const queue: string[] = [from];

  while (queue.length) {
    queue.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity));
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === to) break;

    for (const link of graph.links) {
      if (banned.has(link.id)) continue;
      if (!canTraverse(link, actor)) continue;

      const next = link.a === id ? link.b : link.b === id ? link.a : null;
      if (!next) continue;

      const cost = (dist.get(id) ?? Infinity) + link.time + link.risk * 20;
      if (cost < (dist.get(next) ?? Infinity)) {
        dist.set(next, cost);
        prev.set(next, link);
        queue.push(next);
      }
    }
  }

  if (!dist.has(to)) return null;

  const steps: RoomLink[] = [];
  let cursor = to;
  while (cursor !== from) {
    const link = prev.get(cursor);
    if (!link) return null;
    steps.unshift(link);
    cursor = link.a === cursor ? link.b : link.a;
  }

  const time = steps.reduce((sum, l) => sum + l.time, 0);
  const risk = steps.reduce((sum, l) => sum + l.risk, 0) / Math.max(1, steps.length);
  return { steps, time, risk, score: time + risk * 20 };
}

export function findRoutes(
  graph: BuildingGraph,
  from: string,
  to: string,
  actor: ActorState,
  limit = 3
): Route[] {
  const found: Route[] = [];
  const seen = new Set<string>();
  const bans: Set<string>[] = [new Set()];

  while (bans.length && found.length < limit) {
    const banned = bans.shift()!;
    const route = dijkstra(graph, from, to, banned, actor);
    if (!route) continue;

    const key = route.steps.map((s) => s.id).join('>');
    if (!seen.has(key)) {
      seen.add(key);
      found.push(route);
    }

    for (const step of route.steps) {
      const next = new Set(banned);
      next.add(step.id);
      bans.push(next);
    }
  }

  return found;
}
