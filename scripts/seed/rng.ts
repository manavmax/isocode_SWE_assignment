/**
 * Seeded PRNG for the demo seed (SPEC 14): mulberry32 by Sean Barrett — a
 * 32-bit state generator with a 2^32 period, small, fast and perfectly
 * sufficient for synthetic data. Every helper takes the generator as its
 * first argument so one stream drives the whole run in a fixed order, and
 * the same seed reproduces the same loan universe byte for byte.
 */

export type Rng = () => number;

export function mulberry32(seedInput: number): Rng {
  let a = seedInput >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [minIncl, maxIncl]. */
export function int(rng: Rng, minIncl: number, maxIncl: number): number {
  if (!Number.isInteger(minIncl) || !Number.isInteger(maxIncl) || minIncl > maxIncl) {
    throw new Error(`int: invalid inclusive range [${minIncl}, ${maxIncl}]`);
  }
  const span = maxIncl - minIncl + 1;
  return minIncl + Math.floor(rng() * span);
}

/** Uniform double in [min, max). */
export function uniform(rng: Rng, min: number, max: number): number {
  if (min >= max) {
    throw new Error(`uniform: invalid range [${min}, ${max})`);
  }
  return min + rng() * (max - min);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pick: empty item list');
  }
  return items[Math.floor(rng() * items.length)]!;
}

export function chance(rng: Rng, probability: number): boolean {
  if (probability < 0 || probability > 1) {
    throw new Error(`chance: invalid probability ${probability}`);
  }
  return probability >= 1 || rng() < probability;
}

/** Standard-normal via Marsaglia's polar method on the shared stream. */
export function normal(rng: Rng, mean: number, sd: number): number {
  for (;;) {
    const u = rng() * 2 - 1;
    const v = rng() * 2 - 1;
    const s = u * u + v * v;
    if (s > 0 && s < 1) {
      return mean + sd * u * Math.sqrt((-2 * Math.log(s)) / s);
    }
  }
}

/** Lognormal around a rupee median: value = median * exp(lnSigma * Z),
 *  clipped to [minRupees, maxRupees] (config keeps the clip points). */
export function lognormalClipped(rng: Rng, median: number, lnSigma: number, minRupees: number, maxRupees: number): number {
  if (minRupees > median || median > maxRupees || lnSigma <= 0) {
    throw new Error('lognormalClipped: require min <= median <= max and sigma > 0');
  }
  const raw = median * Math.exp(lnSigma * normal(rng, 0, 1));
  return Math.min(maxRupees, Math.max(minRupees, raw));
}

/** Knuth Poisson for small lambdas (seed bounces demo use only). */
export function poisson(rng: Rng, lambda: number, cap: number): number {
  if (lambda < 0) {
    throw new Error(`poisson: invalid lambda ${lambda}`);
  }
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  while (p > l) {
    p *= rng();
    k += 1;
  }
  return Math.min(cap, k - 1);
}

/** Inclusive-exclusive window helper used everywhere for day offsets. */
export function intIn(rng: Rng, minIncl: number, maxIncl: number): number {
  if (minIncl === maxIncl) {
    return minIncl;
  }
  return int(rng, minIncl, maxIncl);
}
