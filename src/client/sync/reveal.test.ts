/**
 * Phone reveal tests (prompt 10b): cache-first until the end of the IST day,
 * online fetch fallback, offline-without-cache answering the clear bilingual
 * message flag, out-of-window surfacing as an error (SPEC 16 / A57).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBorrowerPhone } from './reveal.js';
import { db, setCachedReveal } from '../dexie/db.js';

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  await db.delete();
  await db.open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('getBorrowerPhone', () => {
  it('serves a cached number with no network call', async () => {
    await setCachedReveal('LN-1', '9876543210', '9876500000');
    const result = await getBorrowerPhone('LN-1');
    expect(result.phone).toBe('9876543210');
    expect(result.altPhone).toBe('9876500000');
    expect(result.offline).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches online, then caches for the rest of the IST day', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { mobile: '9876543210', altMobile: null }));
    const result = await getBorrowerPhone('LN-2');
    expect(result.phone).toBe('9876543210');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/loans/LN-2/reveal-phone');

    // Second call: cache, not network.
    const again = await getBorrowerPhone('LN-2');
    expect(again.phone).toBe('9876543210');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.revealCache.get('LN-2'))!.phone).toBe('9876543210');
  });

  it('offline with no cache answers the offline flag (connect once to reveal)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await getBorrowerPhone('LN-3');
    expect(result.phone).toBeNull();
    expect(result.offline).toBe(true);
  });

  it('a 403 (outside the server window) surfaces as an outside_window error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}));
    const result = await getBorrowerPhone('LN-4');
    expect(result.error).toBe('outside_window');
    expect(result.phone).toBeNull();
  });

  it('a throttled reveal (429) surfaces as a server error, not offline', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {}));
    const result = await getBorrowerPhone('LN-5');
    expect(result.error).toBe('server_error');
    expect(result.offline).toBeUndefined();
  });
});
