/**
 * GPS per SPEC 7: warm up on loan screen, keep best fix (lowest accuracy),
 * accept accuracy <= 100 m → 'ok', else → 'low_accuracy', always non-blocking,
 * clear watch on save or leave, never fabricate coordinates.
 */
import type { GpsStatus } from '../shared/types.js';

export interface GpsFix {
  lat: number;
  lng: number;
  accuracyM: number;
  status: 'ok' | 'low_accuracy';
}

export interface GpsState {
  /** Best fix so far; cleared when the component unmounts or save is called. */
  fix: GpsFix | null;
  /** The raw status driving the gps_status field on events. */
  rawStatus: GpsStatus;
}

/** Start GPS watch on mount. Returns a stop function. The geolocation
 * source is injectable so tests can drive fixes and errors deterministically. */
export function startGpsWatch(
  onFix: (state: GpsState) => void,
  geo: Pick<Geolocation, 'watchPosition' | 'clearWatch'> | undefined = typeof navigator !== 'undefined' ? navigator.geolocation : undefined
): () => void {
  let bestFix: GpsFix | null = null;
  let latestStatus: GpsStatus = 'not_requested';
  let watchId: number | null = null;

  function emit() {
    onFix({ fix: bestFix, rawStatus: latestStatus });
  }

  function handleSuccess(pos: GeolocationPosition) {
    const { latitude, longitude, accuracy } = pos.coords;
    const acc = Math.round(accuracy);
    const status: GpsStatus = acc <= 100 ? 'ok' : 'low_accuracy';
    const fix: GpsFix = { lat: latitude, lng: longitude, accuracyM: acc, status };
    // Keep the best fix by accuracy
    if (!bestFix || accuracy < bestFix.accuracyM) {
      bestFix = fix;
    }
    latestStatus = status;
    emit();
  }

  function handleError(err: GeolocationPositionError) {
    switch (err.code) {
      case err.PERMISSION_DENIED:
        latestStatus = 'denied';
        break;
      case err.POSITION_UNAVAILABLE:
        latestStatus = 'unavailable';
        break;
      case err.TIMEOUT:
        latestStatus = 'timeout';
        break;
    }
    emit();
  }

  if (geo) {
    watchId = geo.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 30_000
    });
  } else {
    latestStatus = 'not_requested';
    emit();
  }

  return () => {
    if (watchId !== null) {
      geo?.clearWatch(watchId);
    }
    bestFix = null;
    watchId = null;
  };
}

/** Build the GPS fields for an event from a GpsState.
 * Returns fields for the event payload (may be empty if no fix). */
export function buildGpsFields(state: GpsState): {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  gps_status?: GpsStatus;
} {
  if (!state.fix) {
    // No GPS fix: report the raw status only if it is an error state
    if (state.rawStatus === 'denied' || state.rawStatus === 'unavailable' || state.rawStatus === 'timeout') {
      return { gps_status: state.rawStatus };
    }
    // not_requested: omit all GPS fields
    return {};
  }
  return {
    lat: state.fix.lat,
    lng: state.fix.lng,
    accuracy_m: state.fix.accuracyM,
    gps_status: state.fix.status
  };
}
