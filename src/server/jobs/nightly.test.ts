import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { cronSecretMatches, isStuck } from './nightly.js';

/**
 * The nightly job's offline surface: the CRON_SECRET bearer gate (constant
 * time, disabled while the env var is unset) and the two routes' auth
 * behaviour without a database. The recompute itself is proven live (the
 * seed runs it through applyImport; a second run must answer updated: 0).
 */

describe('cronSecretMatches (CRON_SECRET bearer gate)', () => {
  it('matches only an exact "Bearer <secret>" header', () => {
    expect(cronSecretMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(cronSecretMatches('Bearer s3cret ', 's3cret')).toBe(false);
    expect(cronSecretMatches('Bearer wrong', 's3cret')).toBe(false);
    expect(cronSecretMatches('s3cret', 's3cret')).toBe(false);
    expect(cronSecretMatches('bearer s3cret', 's3cret')).toBe(false);
  });

  it('is disabled while the env var is unset or empty — the job cannot be probed', () => {
    expect(cronSecretMatches('Bearer anything', undefined)).toBe(false);
    expect(cronSecretMatches('Bearer anything', '')).toBe(false);
    expect(cronSecretMatches(null, 's3cret')).toBe(false);
  });
});

describe('isStuck (SPEC 12: 2 days past due with no officer action)', () => {
  it('flags at two days past due, not one', () => {
    expect(isStuck(0)).toBe(false);
    expect(isStuck(1)).toBe(false);
    expect(isStuck(2)).toBe(true);
    expect(isStuck(9)).toBe(true);
  });
});

describe('POST /api/jobs/nightly auth gate', () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.DATABASE_URL;
  });

  it('answers 401 without a bearer header', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await app.request('/api/jobs/nightly', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('answers 401 with a wrong bearer token', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await app.request('/api/jobs/nightly', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' }
    });
    expect(res.status).toBe(401);
  });

  it('answers 401 even when the deployment never set CRON_SECRET', async () => {
    const res = await app.request('/api/jobs/nightly', {
      method: 'POST',
      headers: { authorization: 'Bearer anything' }
    });
    expect(res.status).toBe(401);
  });

  it('degrades with 503 when the token is right but the database is unreachable', async () => {
    process.env.CRON_SECRET = 's3cret';
    delete process.env.DATABASE_URL;
    const res = await app.request('/api/jobs/nightly', {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret' }
    });
    const body = (await res.json()) as { status: string };
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
  });
});

describe('GET /api/me/promises auth gate', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('answers 401 with no session cookie', async () => {
    const res = await app.request('/api/me/promises');
    expect(res.status).toBe(401);
  });

  it('degrades with 503 when the session lookup cannot reach the database', async () => {
    const res = await app.request('/api/me/promises', { headers: { cookie: 'fc_session=some-token' } });
    const body = (await res.json()) as { status: string };
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
  });
});
