/**
 * GPS capture tests (SPEC 7 / prompt 10b): warm up with watchPosition, keep
 * the best fix, accept accuracy <= 100 m else low_accuracy, error statuses
 * surface without coordinates, the watch is clearable — and saving is never
 * blocked by GPS.
 */
import { describe, expect, it, vi } from 'vitest';
import { startGpsWatch, buildGpsFields, type GpsState } from './gps.js';

type FixHandler = (pos: GeolocationPosition) => void;
type ErrHandler = (err: GeolocationPositionError) => void;

interface FakeGeo {
  watchPosition: (ok: FixHandler, err: ErrHandler, opts?: object) => number;
  clearWatch: (id: number) => void;
  emitFix: (pos: Partial<GeolocationCoordinates>) => void;
  emitError: (code: number) => void;
  callCount: () => number;
}

function fakeGeo(): FakeGeo {
  let ok: FixHandler | null = null;
  let err: ErrHandler | null = null;
  let nextId = 1;
  let calls = 0;
  return {
    watchPosition: (success, failure) => {
      calls++;
      ok = success;
      err = failure;
      return nextId++;
    },
    clearWatch: vi.fn(),
    emitFix: (coords) => {
      ok?.({ coords: { latitude: 22.7196, longitude: 75.8577, accuracy: 10, ...coords } } as GeolocationPosition);
    },
    emitError: (code) => {
      err?.({ code, message: 'x', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    },
    callCount: () => calls
  };
}

describe('startGpsWatch', () => {
  it('keeps the BEST fix when several arrive', () => {
    const geo = fakeGeo();
    const states: GpsState[] = [];
    const stop = startGpsWatch((s) => states.push(s), geo as unknown as Geolocation);
    geo.emitFix({ accuracy: 40 });
    geo.emitFix({ accuracy: 8 });
    geo.emitFix({ accuracy: 90 }); // worse than the 8 m fix — ignored
    const last = states.at(-1)!;
    expect(last.fix!.accuracyM).toBe(8);
    expect(last.fix!.status).toBe('ok');
    stop();
  });

  it('accuracy <= 100 m is ok; beyond that the fix is low_accuracy but still kept', () => {
    const geo = fakeGeo();
    const states: GpsState[] = [];
    const stop = startGpsWatch((s) => states.push(s), geo as unknown as Geolocation);
    geo.emitFix({ accuracy: 101 });
    expect(states.at(-1)!.fix!.status).toBe('low_accuracy');
    geo.emitFix({ accuracy: 100 });
    expect(states.at(-1)!.fix!.status).toBe('ok');
    stop();
  });

  it('error statuses surface (denied/unavailable/timeout) and never fabricate coordinates', () => {
    const geo = fakeGeo();
    const states: GpsState[] = [];
    const stop = startGpsWatch((s) => states.push(s), geo as unknown as Geolocation);
    geo.emitError(1);
    expect(states.at(-1)!.rawStatus).toBe('denied');
    expect(states.at(-1)!.fix).toBeNull();
    geo.emitError(2);
    expect(states.at(-1)!.rawStatus).toBe('unavailable');
    geo.emitError(3);
    expect(states.at(-1)!.rawStatus).toBe('timeout');
    stop();
  });

  it('stopping clears the watch (clear on save or leave)', () => {
    const geo = fakeGeo();
    const stop = startGpsWatch(() => {}, geo as unknown as Geolocation);
    expect(geo.callCount()).toBe(1);
    stop();
    expect(geo.clearWatch).toHaveBeenCalledTimes(1);
  });

  it('without a geolocation the status stays not_requested and saving still works', () => {
    const states: GpsState[] = [];
    const stop = startGpsWatch((s) => states.push(s), undefined);
    expect(states.at(-1)!.rawStatus).toBe('not_requested');
    expect(buildGpsFields(states.at(-1)!)).toEqual({});
    stop();
  });
});

describe('buildGpsFields', () => {
  it('a fix reports all four fields', () => {
    const fields = buildGpsFields({
      fix: { lat: 22.7, lng: 75.8, accuracyM: 120, status: 'low_accuracy' },
      rawStatus: 'low_accuracy'
    });
    expect(fields).toEqual({ lat: 22.7, lng: 75.8, accuracy_m: 120, gps_status: 'low_accuracy' });
  });

  it('an error status reports ONLY the status — half a position is never written', () => {
    expect(buildGpsFields({ fix: null, rawStatus: 'denied' })).toEqual({ gps_status: 'denied' });
    expect(buildGpsFields({ fix: null, rawStatus: 'timeout' })).toEqual({ gps_status: 'timeout' });
    expect(buildGpsFields({ fix: null, rawStatus: 'not_requested' })).toEqual({});
  });
});
