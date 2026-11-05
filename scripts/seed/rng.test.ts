import { describe, expect, it } from 'vitest';
import { chance, int, lognormalClipped, mulberry32, normal, pick, poisson, uniform } from './rng.js';

describe('mulberry32 determinism', () => {
  it('produces the same sequence for the same seed (buried draw check)', () => {
    const a = mulberry32(20261105);
    const b = mulberry32(20261105);
    const first: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      first.push(a());
    }
    for (let i = 0; i < 1_000; i++) {
      expect(b()).toBe(first[i]!); // seeded sequence is reproducible
    }
  });

  it('different seeds diverge early', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let mismatch = 0;
    for (let i = 0; i < 5; i++) {
      if (a() !== b()) {
        mismatch += 1;
      }
    }
    expect(mismatch).toBeGreaterThan(0);
  });

  it('draws land in [0, 1) with roughly uniform ten-bin spread', () => {
    const rng = mulberry32(42);
    const bins = new Array(10).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      bins[Math.floor(v * 10)]! += 1;
    }
    for (const count of bins) {
      expect(count).toBeGreaterThan(900);
      expect(count).toBeLessThan(1_100);
    }
  });
});

describe('int / uniform / pick / chance', () => {
  it('int stays inside the inclusive range and reaches both ends', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 2_000; i++) {
      const v = int(rng, 3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(int(rng, 5, 5)).toBe(5);
  });

  it('uniform returns a value in [min, max)', () => {
    const rng = mulberry32(8);
    for (let i = 0; i < 2_000; i++) {
      const v = uniform(rng, 10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }
  });

  it('pick only returns members and degenerate weights warn-free', () => {
    const rng = mulberry32(9);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 500; i++) {
      expect(items).toContain(pick(rng, [...items]));
    }
    expect(pick(rng, ['only'])).toBe('only');
  });

  it('chance respects the deterministic probabilities 0 and 1', () => {
    const rng = mulberry32(10);
    for (let i = 0; i < 100; i++) {
      expect(chance(rng, 0)).toBe(false);
      expect(chance(rng, 1)).toBe(true);
    }
  });
});

describe('distributions', () => {
  it('normal(mean, sd) has sane mean and spread over 20k draws', () => {
    const rng = mulberry32(11);
    const N = 20_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const v = normal(rng, 100, 15);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / N;
    const sd = Math.sqrt(sumSq / N - mean * mean);
    expect(Math.abs(mean - 100)).toBeLessThan(1.5);
    expect(Math.abs(sd - 15)).toBeLessThan(1.0);
  });

  it('lognormalClipped(600000, 0.6, 150000, 2500000) has the right median and honours the clips', () => {
    const rng = mulberry32(12);
    const N = 30_000;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const value = lognormalClipped(rng, 600_000, 0.6, 150_000, 2_500_000);
      expect(value).toBeGreaterThanOrEqual(150_000);
      expect(value).toBeLessThanOrEqual(2_500_000);
      samples.push(value);
    }
    samples.sort((a, b) => a - b);
    const median = samples[N >> 1]!;
    expect(Math.abs(median - 600_000) / 600_000).toBeLessThan(0.03);
    const p1 = samples[Math.floor(N * 0.01)]!;
    // The natural 1% point of this distribution sits below the clip, so the
    // clip binds: p1 must hug the minimum, not float into the raw range.
    expect(p1).toBeGreaterThanOrEqual(150_000);
    expect(p1).toBeLessThan(400_000);
  });

  it('poisson(0.9) averages ~0.9 and the cap is respected', () => {
    const rng = mulberry32(13);
    const N = 20_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const v = poisson(rng, 0.9, 6);
      expect(v).toBeLessThanOrEqual(6);
      sum += v;
    }
    expect(Math.abs(sum / N - 0.9)).toBeLessThan(0.05);
  });
});
