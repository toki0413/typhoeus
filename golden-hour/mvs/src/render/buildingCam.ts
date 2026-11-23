export interface BuildingShot {
  roomId: string;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 房间机位只由 roomId / floor / 烟浓度决定，保证切镜稳定可复现。 */
export function shotFor(roomId: string, floor: number, smoke: number): BuildingShot {
  const hash = hashString(roomId);
  const offset = ((hash % 2001) / 1000 - 1) * 1.2;
  const lean = ((hash >>> 11) % 1000) / 1000 - 0.5;
  const closeness = 1 + smoke * 0.8;

  return {
    roomId,
    position: [offset, 4.2 + floor * 3 - smoke * 1.4, 7.5 / closeness],
    target: [lean, floor * 3 + 1.2, 0],
    zoom: 1 + smoke * 0.5,
  };
}
