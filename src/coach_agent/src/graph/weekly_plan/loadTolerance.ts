export const LOAD_MATCH_TOLERANCE = 0.1;

export function acceptedLoadBand(low: number, high: number, tolerance: number = LOAD_MATCH_TOLERANCE): { low: number; high: number } {
  return {
    low: roundDose(low * (1 - tolerance)),
    high: roundDose(high * (1 + tolerance)),
  };
}

function roundDose(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
