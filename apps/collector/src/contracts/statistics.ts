import { dual } from "effect/Function";

/** Return the arithmetic mean, or `null` when there are no observations. */
export function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Select a nearest-rank percentile from an already sorted sample.
 * Callers sort their own input so this helper never mutates caller-owned data.
 */
export const percentile: {
  (sorted: ReadonlyArray<number>, fraction: number): number | null;
  (fraction: number): (sorted: ReadonlyArray<number>) => number | null;
} = dual(2, (sorted: ReadonlyArray<number>, fraction: number): number | null => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
});
