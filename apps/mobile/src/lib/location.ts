import * as Location from 'expo-location';

export type Fix = { lat: number; lng: number; accuracyM: number };

export type LocationErrorCode = 'permission_denied' | 'services_off' | 'timeout' | 'unavailable';

export class LocationError extends Error {
  constructor(readonly code: LocationErrorCode) {
    super(code);
  }
}

// FR-ATT-02: a fix that takes longer than this is given up on.
const TIMEOUT_MS = 15_000;

/**
 * One high-accuracy position, asked for while the app is in use. Whether the accuracy is good
 * enough is the server's decision (Settings), so any accuracy is returned as it is.
 */
export async function getCurrentFix(): Promise<Fix> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) throw new LocationError('permission_denied');
    if (!(await Location.hasServicesEnabledAsync())) throw new LocationError('services_off');

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LocationError('timeout')), TIMEOUT_MS);
    });
    const { coords } = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
      timeout,
    ]);
    // Without an accuracy the server cannot judge the fix.
    if (coords.accuracy === null) throw new LocationError('unavailable');
    return { lat: coords.latitude, lng: coords.longitude, accuracyM: coords.accuracy };
  } catch (failure) {
    // The native error is dropped unlogged: it can carry the position.
    throw failure instanceof LocationError ? failure : new LocationError('unavailable');
  } finally {
    clearTimeout(timer);
  }
}
