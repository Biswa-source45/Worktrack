import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { resetSecureStore, secureStoreContents } from '@/test/secure-store-mock';
import { clearTokens, getDeviceInfo, getTokens, setTokens } from './token-store';

beforeEach(() => {
  resetSecureStore();
  jest.mocked(Crypto.randomUUID).mockClear();
});

describe('tokens', () => {
  it('returns null when nothing is stored', async () => {
    expect(await getTokens()).toBeNull();
  });

  it('stores and reads the pair, and clears it', async () => {
    await setTokens({ access: 'a', refresh: 'r' });
    expect(await getTokens()).toEqual({ access: 'a', refresh: 'r' });
    await clearTokens();
    expect(await getTokens()).toBeNull();
  });

  it('keeps the device id when tokens are cleared', async () => {
    const { device_id } = await getDeviceInfo();
    await setTokens({ access: 'a', refresh: 'r' });
    await clearTokens();
    expect((await getDeviceInfo()).device_id).toBe(device_id);
  });
});

describe('getDeviceInfo', () => {
  it('generates the device id once and reuses it', async () => {
    const first = await getDeviceInfo();
    const second = await getDeviceInfo();
    expect(second.device_id).toBe(first.device_id);
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(Object.values(secureStoreContents())).toContain(first.device_id);
    expect(first.device_id.length).toBeGreaterThanOrEqual(8);
  });

  it('fills every field with a non-empty value', async () => {
    const info = await getDeviceInfo();
    expect(info.model).toBe('Test Phone');
    expect(info.os).toMatch(/^(ios|android) \S+/);
    expect(info.app_version.length).toBeGreaterThan(0);
  });

  it('falls back to the device name, then Unknown, for the model', async () => {
    jest.replaceProperty(Device, 'modelName', null);
    expect((await getDeviceInfo()).model).toBe('Test device');
    jest.replaceProperty(Device, 'deviceName', null);
    expect((await getDeviceInfo()).model).toBe('Unknown');
    jest.restoreAllMocks();
  });
});
