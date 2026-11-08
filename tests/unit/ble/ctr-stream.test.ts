import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CtrStream } from '../../../src/core/ble/ctr-stream';
import { concatBytes } from '../../../src/core/util/bytes';

describe('CtrStream (stateful AES-256-CTR over WebCrypto)', () => {
  it('equals one continuous node:crypto CTR stream for random chunkings', async () => {
    for (let trial = 0; trial < 20; trial++) {
      const key = new Uint8Array(randomBytes(32));
      const nonce = new Uint8Array(randomBytes(12));
      const data = new Uint8Array(randomBytes(3000 + trial * 37));
      const ref = createCipheriv('aes-256-ctr', key, concatBytes(nonce, Uint8Array.of(0, 0, 0, 1)));
      const expected = new Uint8Array(ref.update(data));

      const stream = CtrStream.withKey(await CtrStream.importKey(key), nonce);
      const pending: Promise<Uint8Array>[] = [];
      for (let i = 0; i < data.length; ) {
        const n = Math.min(data.length - i, 1 + Math.floor(Math.random() * 70));
        pending.push(stream.process(data.subarray(i, i + n))); // not awaited: order must still hold
        i += n;
      }
      const got = concatBytes(...(await Promise.all(pending)));
      expect(got).toEqual(expected);
      expect(stream.position).toBe(data.length);
    }
  });

  it('decrypts what it encrypts', async () => {
    const key = await CtrStream.importKey(new Uint8Array(randomBytes(32)));
    const nonce = new Uint8Array(randomBytes(12));
    const enc = CtrStream.withKey(key, nonce);
    const dec = CtrStream.withKey(key, nonce);
    const msg = new TextEncoder().encode('{"v":1,"id":1,"command":"hello"}\n'.repeat(9));
    const c1 = await enc.process(msg.subarray(0, 17));
    const c2 = await enc.process(msg.subarray(17));
    const p = concatBytes(await dec.process(c1.subarray(0, 5)), await dec.process(concatBytes(c1.subarray(5), c2)));
    expect(p).toEqual(msg);
  });
});
