// Stand-in for expo-crypto, installed by jest.setup.ts: Node's crypto does what the native AES
// module does (AES-GCM, 12-byte IV, 16-byte tag, sealed data laid out as IV + ciphertext + tag).
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { CipherGCM, DecipherGCM } from 'crypto';

type BinaryInput = string | Uint8Array | ArrayBuffer;
const IV = 12;
const TAG = 16;

export const randomUUID = jest.fn(() => '11111111-2222-3333-4444-555555555555');
export const getRandomBytes = (count: number) => new Uint8Array(randomBytes(count));

const bytesOf = (input: BinaryInput): Buffer =>
  typeof input === 'string'
    ? Buffer.from(input, 'base64')
    : Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input);

export const AESKeySize = { AES128: 128, AES192: 192, AES256: 256 };

export class AESEncryptionKey {
  constructor(readonly raw: Buffer) {}
  get size() {
    return this.raw.length * 8;
  }
  static async generate(size = 256) {
    return new AESEncryptionKey(randomBytes(size / 8));
  }
  static async import(input: Uint8Array | string, encoding?: 'hex' | 'base64') {
    const raw = typeof input === 'string' ? Buffer.from(input, encoding) : Buffer.from(input);
    if (![16, 24, 32].includes(raw.length)) throw new Error('Invalid key size');
    return new AESEncryptionKey(raw);
  }
  async bytes() {
    return new Uint8Array(this.raw);
  }
  async encoded(encoding: 'hex' | 'base64') {
    return this.raw.toString(encoding);
  }
}

export class AESSealedData {
  constructor(readonly packed: Buffer) {}
  static fromCombined(combined: BinaryInput) {
    return new AESSealedData(bytesOf(combined));
  }
  async combined(encoding: 'bytes' | 'base64' = 'bytes') {
    return encoding === 'base64' ? this.packed.toString('base64') : new Uint8Array(this.packed);
  }
}

export async function aesEncryptAsync(plaintext: BinaryInput, key: AESEncryptionKey) {
  const iv = randomBytes(IV);
  const cipher = createCipheriv(`aes-${key.size}-gcm` as 'aes-256-gcm', key.raw, iv) as CipherGCM;
  const body = Buffer.concat([cipher.update(bytesOf(plaintext)), cipher.final()]);
  return new AESSealedData(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

export async function aesDecryptAsync(
  sealed: AESSealedData,
  key: AESEncryptionKey,
  options: { output?: 'bytes' | 'base64' } = {},
) {
  const { packed } = sealed;
  const decipher = createDecipheriv(
    `aes-${key.size}-gcm` as 'aes-256-gcm',
    key.raw,
    packed.subarray(0, IV),
  ) as DecipherGCM;
  decipher.setAuthTag(packed.subarray(packed.length - TAG));
  const plain = Buffer.concat([
    decipher.update(packed.subarray(IV, packed.length - TAG)),
    decipher.final(),
  ]);
  return options.output === 'base64' ? plain.toString('base64') : new Uint8Array(plain);
}
