import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Tokens and the device id live only in SecureStore (Keychain / Keystore), never in AsyncStorage.
const ACCESS_KEY = 'worktrack.access_token';
const REFRESH_KEY = 'worktrack.refresh_token';
const DEVICE_ID_KEY = 'worktrack.device_id';

export type Tokens = { access: string; refresh: string };

export async function getTokens(): Promise<Tokens | null> {
  const [access, refresh] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_KEY),
    SecureStore.getItemAsync(REFRESH_KEY),
  ]);
  return access && refresh ? { access, refresh } : null;
}

export async function setTokens({ access, refresh }: Tokens): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, access),
    SecureStore.setItemAsync(REFRESH_KEY, refresh),
  ]);
}

// The device id is kept: signing out must not make the phone look like a new device.
export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}

// Hermes has no global crypto.randomUUID, hence expo-crypto.
async function getDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  return id;
}

// "iOS 27.0.1", "Android 13". Shown on the device card and stored by the server, whose column
// holds 64 characters.
function osLabel(): string {
  if (Device.osName && Device.osVersion) return `${Device.osName} ${Device.osVersion}`.slice(0, 64);
  // Only when the native module reports nothing; on Android Platform.Version is the API level.
  const name =
    Platform.OS === 'ios' ? 'iOS' : Platform.OS.charAt(0).toUpperCase() + Platform.OS.slice(1);
  return `${name} ${Platform.Version}`.slice(0, 64);
}

export async function getDeviceInfo() {
  return {
    device_id: await getDeviceId(),
    model: Device.modelName ?? Device.deviceName ?? 'Unknown',
    os: osLabel(),
    app_version: Constants.expoConfig?.version ?? '0',
  };
}
