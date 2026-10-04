import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
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
    expect(info.os).toMatch(/^(iOS|Android) \S+/);
    expect(info.app_version.length).toBeGreaterThan(0);
  });

  describe('os', () => {
    afterEach(() => jest.restoreAllMocks());

    it('is the iOS name and version', async () => {
      expect((await getDeviceInfo()).os).toBe('iOS 27.0.1');
    });

    it('is the Android name and release, not the API level', async () => {
      jest.replaceProperty(Device, 'osName', 'Android');
      jest.replaceProperty(Device, 'osVersion', '13');
      jest.replaceProperty(Platform, 'OS', 'android');
      jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33);
      expect((await getDeviceInfo()).os).toBe('Android 13');
    });

    it('never exceeds the 64 characters the server accepts', async () => {
      jest.replaceProperty(Device, 'osVersion', '9'.repeat(80));
      expect((await getDeviceInfo()).os).toHaveLength(64);
    });

    it.each([
      ['ios', '27.0', 'iOS 27.0'],
      ['android', 33, 'Android 33'],
    ] as const)(
      'falls back to a capitalised %s when the device reports nothing',
      async (os, version, expected) => {
        jest.replaceProperty(Device, 'osName', null);
        jest.replaceProperty(Device, 'osVersion', null);
        jest.replaceProperty(Platform, 'OS', os);
        jest.spyOn(Platform, 'Version', 'get').mockReturnValue(version);
        expect((await getDeviceInfo()).os).toBe(expected);
      },
    );
  });

  it('falls back to the device name, then Unknown, for the model', async () => {
    jest.replaceProperty(Device, 'modelName', null);
    expect((await getDeviceInfo()).model).toBe('Test device');
    jest.replaceProperty(Device, 'deviceName', null);
    expect((await getDeviceInfo()).model).toBe('Unknown');
    jest.restoreAllMocks();
  });
});
