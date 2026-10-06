import { QUEUE_KEY, open, seal } from './queue-seal';
import { resetSecureStore, secureStoreContents } from '@/test/secure-store-mock';

const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => resetSecureStore());

describe('queue seal', () => {
  it('seals and opens again, and the sealed bytes do not contain the text', async () => {
    const sealed = await seal(bytes('lat 20.2961, selfie data'));
    expect(Buffer.from(sealed).toString('latin1')).not.toContain('selfie');
    expect(new TextDecoder().decode(await open(sealed))).toBe('lat 20.2961, selfie data');
  });

  it('makes a 256-bit key once and keeps it in the secure store', async () => {
    expect(secureStoreContents()[QUEUE_KEY]).toBeUndefined();
    await seal(bytes('one'));
    const stored = secureStoreContents()[QUEUE_KEY];
    expect(QUEUE_KEY).toBe('worktrack.queue-key');
    expect(Buffer.from(stored, 'base64')).toHaveLength(32);
    await seal(bytes('two'));
    expect(secureStoreContents()[QUEUE_KEY]).toBe(stored);
  });

  it('uses a new nonce each time, so the same text never seals to the same bytes', async () => {
    const [a, b] = [await seal(bytes('same')), await seal(bytes('same'))];
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('cannot open a blob after the key is gone', async () => {
    const sealed = await seal(bytes('secret'));
    resetSecureStore(); // the app's data was cleared: a new key is made on the next use
    await expect(open(sealed)).rejects.toThrow();
  });

  it('cannot open a blob that was changed', async () => {
    const sealed = await seal(bytes('secret'));
    sealed[sealed.length - 20] ^= 0xff;
    await expect(open(sealed)).rejects.toThrow();
  });
});
