import {
  AESEncryptionKey,
  AESKeySize,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

// The key never leaves the Keystore-backed SecureStore; the sealed punches sit in SQLite. Clearing
// the app's data removes both, so a stray key or blob alone reveals nothing.
export const QUEUE_KEY = 'worktrack.queue-key';

async function key(): Promise<AESEncryptionKey> {
  const stored = await SecureStore.getItemAsync(QUEUE_KEY);
  if (stored) return AESEncryptionKey.import(stored, 'base64');
  const fresh = await AESEncryptionKey.generate(AESKeySize.AES256);
  await SecureStore.setItemAsync(QUEUE_KEY, await fresh.encoded('base64'));
  return fresh;
}

/** AES-256-GCM; the result is IV + ciphertext + tag. */
export async function seal(plain: Uint8Array): Promise<Uint8Array> {
  const sealed = await aesEncryptAsync(plain, await key());
  return sealed.combined();
}

/** Throws when the blob was not sealed with the current key. */
export async function open(blob: Uint8Array): Promise<Uint8Array> {
  return aesDecryptAsync(AESSealedData.fromCombined(blob), await key());
}
