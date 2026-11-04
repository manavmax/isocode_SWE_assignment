import { afterEach, describe, expect, it } from 'vitest';
import { app } from './app.js';

describe('GET /api/health', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('reports degraded with 503 when DATABASE_URL is not set', async () => {
    const res = await app.request('/api/health');
    const body = (await res.json()) as { status: string; db: string; time: string };
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('error');
    expect(typeof body.time).toBe('string');
  });
});
