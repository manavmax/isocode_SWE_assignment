import { afterEach, describe, expect, it } from 'vitest';
import { app } from './app.js';

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

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

describe('POST /api/import auth gate', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns 401 when no basic credentials are present', async () => {
    const res = await app.request('/api/import', { method: 'POST' });
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 for a malformed basic header', async () => {
    const res = await app.request('/api/import', { method: 'POST', headers: { Authorization: 'Bearer abc' } });
    expect(res.status).toBe(401);
  });

  it('reports degraded when credentials parse but the database is unavailable', async () => {
    const res = await app.request('/api/import', {
      method: 'POST',
      headers: { Authorization: basic('mgr@example.com', 'pw') }
    });
    const body = (await res.json()) as { status: string };
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
  });
});

describe('GET /api/import/:id/errors.csv auth gate', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns 401 when no basic credentials are present', async () => {
    const res = await app.request('/api/import/00000000-0000-4000-8000-000000000001/errors.csv');
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('reports degraded when credentials parse but the database is unavailable', async () => {
    const res = await app.request('/api/import/00000000-0000-4000-8000-000000000001/errors.csv', {
      headers: { Authorization: basic('mgr@example.com', 'pw') }
    });
    const body = (await res.json()) as { status: string };
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
  });
});
