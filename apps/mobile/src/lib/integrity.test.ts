import * as Device from 'expo-device';
import { getIntegrity } from './integrity';

const rooted = jest.mocked(Device.isRootedExperimentalAsync);
const device = Device as { isDevice: boolean };

beforeEach(() => {
  device.isDevice = true;
  rooted.mockReset();
  rooted.mockResolvedValue(false);
});

describe('getIntegrity', () => {
  it('reports a normal phone as neither an emulator nor rooted', async () => {
    await expect(getIntegrity()).resolves.toEqual({ emulator: false, rooted: false });
  });

  it('reports an emulator', async () => {
    device.isDevice = false;
    expect((await getIntegrity()).emulator).toBe(true);
  });

  it('reports a rooted phone', async () => {
    rooted.mockResolvedValue(true);
    expect((await getIntegrity()).rooted).toBe(true);
  });

  it('counts a failed root check as not rooted, says so in the log, and does not throw', async () => {
    rooted.mockRejectedValue(new Error('native failure'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(getIntegrity()).resolves.toEqual({ emulator: false, rooted: false });
    expect(warn).toHaveBeenCalledWith('[integrity] the root check failed', expect.any(Error));
    warn.mockRestore();
  });
});
