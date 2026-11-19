export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function stepSmoke(smoke: number[], fire: number, dt: number): void {
  smoke[0] = clamp01(smoke[0] + (fire * 0.62 - smoke[0] * 0.22) * dt);
  for (let i = 1; i < smoke.length; i++) {
    const inflow = smoke[i - 1] * 0.34;
    const outflow = smoke[i] * 0.12;
    smoke[i] = clamp01(smoke[i] + (inflow - outflow) * dt);
  }
}
