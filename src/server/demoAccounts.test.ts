import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.js';

vi.mock('./dal.js', () => ({
  listDemoUsernames: vi.fn(async () => ['demo-manager', 'demo-officer-1', 'demo-officer-2'])
}));

import { listDemoUsernames } from './dal.js';

const mockedUsernames = vi.mocked(listDemoUsernames);

afterEach(() => {
  vi.unstubAllEnvs();
  mockedUsernames.mockClear();
});

describe('GET /api/demo-accounts (SPEC 16: demo chips gated by DEMO_MODE)', () => {
  it('returns usernames only while DEMO_MODE is on', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const res = await app.request('/api/demo-accounts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usernames: unknown };
    expect(body).toEqual({ usernames: ['demo-manager', 'demo-officer-1', 'demo-officer-2'] });
    expect(Object.keys(body)).toEqual(['usernames']);
    expect(mockedUsernames).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list without touching the db when DEMO_MODE is off', async () => {
    vi.stubEnv('DEMO_MODE', '');
    const res = await app.request('/api/demo-accounts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ usernames: [] });
    expect(mockedUsernames).not.toHaveBeenCalled();
  });
});
