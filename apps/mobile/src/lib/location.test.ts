import * as Location from 'expo-location';
import { LocationError, getCurrentFix } from './location';

const permission = jest.mocked(Location.requestForegroundPermissionsAsync);
const services = jest.mocked(Location.hasServicesEnabledAsync);
const position = jest.mocked(Location.getCurrentPositionAsync);

type Position = Awaited<ReturnType<typeof Location.getCurrentPositionAsync>>;
const at = (accuracy: number | null) =>
  ({ coords: { latitude: 20.2961, longitude: 85.8245, accuracy }, timestamp: 0 }) as Position;

const codeOf = (attempt: Promise<unknown>) =>
  attempt.then(
    () => 'no error',
    (error: unknown) => (error instanceof LocationError ? error.code : error),
  );

beforeEach(() => {
  jest.clearAllMocks();
  permission.mockResolvedValue({ granted: true } as Awaited<ReturnType<typeof permission>>);
  services.mockResolvedValue(true);
  position.mockResolvedValue(at(12.4));
});

afterEach(() => jest.useRealTimers());

describe('getCurrentFix', () => {
  it('returns one highest-accuracy position with its accuracy, whatever that is', async () => {
    position.mockResolvedValue(at(180));
    await expect(getCurrentFix()).resolves.toEqual({ lat: 20.2961, lng: 85.8245, accuracyM: 180 });
    expect(position).toHaveBeenCalledTimes(1);
    expect(position).toHaveBeenCalledWith({ accuracy: Location.Accuracy.Highest });
  });

  it('asks only for the while-in-use permission', async () => {
    await getCurrentFix();
    expect(permission).toHaveBeenCalledTimes(1);
  });

  it('fails with permission_denied and asks for no position', async () => {
    permission.mockResolvedValue({ granted: false } as Awaited<ReturnType<typeof permission>>);
    expect(await codeOf(getCurrentFix())).toBe('permission_denied');
    expect(position).not.toHaveBeenCalled();
  });

  it('fails with services_off when location is switched off on the phone', async () => {
    services.mockResolvedValue(false);
    expect(await codeOf(getCurrentFix())).toBe('services_off');
    expect(position).not.toHaveBeenCalled();
  });

  it('fails with timeout when no position arrives within 15 seconds', async () => {
    jest.useFakeTimers();
    position.mockReturnValue(new Promise<Position>(() => undefined));
    const outcome = codeOf(getCurrentFix());
    await jest.advanceTimersByTimeAsync(14_999);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('timeout');
  });

  it('leaves no timer behind once the position has arrived', async () => {
    jest.useFakeTimers();
    await getCurrentFix();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails with unavailable when the phone cannot give a position', async () => {
    position.mockRejectedValue(new Error('Current location is unavailable.'));
    expect(await codeOf(getCurrentFix())).toBe('unavailable');
  });

  it('fails with unavailable when the position has no accuracy', async () => {
    position.mockResolvedValue(at(null));
    expect(await codeOf(getCurrentFix())).toBe('unavailable');
  });

  it('fails with unavailable when the permission prompt itself breaks', async () => {
    permission.mockRejectedValue(new Error('native failure'));
    expect(await codeOf(getCurrentFix())).toBe('unavailable');
  });
});
