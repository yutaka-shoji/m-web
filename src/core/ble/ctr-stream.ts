/**
 * Stateful AES-256-CTR stream on top of stateless WebCrypto.
 *
 * After the XBee BLE unlock, each direction is one continuous CTR keystream starting at
 * counter block `nonce(12) ‖ BE32(1)`, spanning frames and GATT packets (the reference
 * client keeps one cipher object per direction). WebCrypto restarts the keystream on
 * every call, so we track the byte offset ourselves: a call at offset `off` starts at
 * block ⌊off/16⌋ and discards `off % 16` keystream bytes.
 *
 * Offsets are assigned synchronously in call order and results resolve in call order.
 */
export class CtrStream {
  private offset = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly key: CryptoKey;
  private readonly nonce: Uint8Array;

  private constructor(key: CryptoKey, nonce: Uint8Array) {
    if (nonce.length !== 12) throw new RangeError('CTR nonce must be 12 bytes');
    this.key = key;
    this.nonce = nonce;
  }

  static async importKey(rawKey: Uint8Array): Promise<CryptoKey> {
    if (rawKey.length !== 32) throw new RangeError('AES-256 key must be 32 bytes');
    return crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-CTR' }, false, ['encrypt']);
  }

  static withKey(key: CryptoKey, nonce: Uint8Array): CtrStream {
    return new CtrStream(key, nonce.slice());
  }

  /** Bytes consumed so far. */
  get position(): number {
    return this.offset;
  }

  /** XOR `data` with the keystream at the current position (encrypt == decrypt). */
  process(data: Uint8Array): Promise<Uint8Array> {
    const off = this.offset;
    this.offset += data.length;
    const run = this.tail.then(() => this.xorAt(off, data));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async xorAt(off: number, data: Uint8Array): Promise<Uint8Array> {
    if (data.length === 0) return new Uint8Array(0);
    const block = Math.floor(off / 16);
    const skip = off % 16;
    const nBlocks = Math.ceil((skip + data.length) / 16);
    const counter = new Uint8Array(16);
    counter.set(this.nonce, 0);
    new DataView(counter.buffer).setUint32(12, (1 + block) >>> 0, false);
    const ks = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CTR', counter, length: 32 }, this.key, new Uint8Array(nBlocks * 16)),
    );
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ ks[skip + i]!;
    return out;
  }
}
