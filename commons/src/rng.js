// Deterministic randomness + hashing + procedural naming.
// Every recipe is reproducible from (genome, environment, rngSeed, engineVersion).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashInts(ints) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ints.length; i++) {
    h ^= ints[i] & 0xffffffff;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function toHex(n, len = 6) {
  return (n >>> 0).toString(16).toUpperCase().padStart(len, '0').slice(-len);
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (v, d = 1) => {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
};
export const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];
export const randInt = (rand, min, max) => min + Math.floor(rand() * (max - min + 1));

const ZH_A = ['苔', '荧', '潮', '孢', '雾', '砂', '弦', '焰', '环', '夜', '露', '绒', '晶', '游', '涡', '韶', '森', '澜', '烬', '霜'];
const ZH_B = ['歌', '环', '簇', '灵', '脉', '织', '隐', '旅', '种', '息', '涡', '栖', '蜕', '吟'];
const LAT_A = ['Vire', 'Noct', 'Thren', 'Luma', 'Myce', 'Cora', 'Pale', 'Vespi', 'Ulva', 'Sere', 'Glim', 'Rhoe', 'Nema', 'Zoa', 'Aure', 'Clyt'];
const LAT_B = ['ella', 'ora', 'ith', 'aea', 'yn', 'oma', 'essa', 'ula'];

export function proceduralName(hash) {
  const h = hash >>> 0;
  const a = ZH_A[h % ZH_A.length];
  const b = ZH_B[Math.floor(h / 7) % ZH_B.length];
  const code = String((h % 97) + 3).padStart(2, '0');
  const la = LAT_A[Math.floor(h / 13) % LAT_A.length];
  const lb = LAT_B[Math.floor(h / 29) % LAT_B.length];
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'][h % 9];
  return {
    zh: `${a}${b}·${code}`,
    latin: `${la}${lb} ${roman}`,
  };
}

export function uid(prefix = 's') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function shuffle(rand, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
