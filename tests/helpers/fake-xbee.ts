/**
 * Test double for an M-Logger's XBee 3 BLE API service (server side of the link).
 *
 * - SRP server with the firmware's salt and verifier (xbee_controller.c at$S / at$V..$Y)
 * - AES-256-CTR via node:crypto's *stateful* cipher (independent of the WebCrypto client)
 * - User Data Relay: 0x2D frames from the client are handed to `onRelay`; `sendRelay()`
 *   emits 0xAD frames as indications, split at random sizes like a real BLE link.
 */
import { createCipheriv, createDecipheriv, randomBytes, type Cipheriv, type Decipheriv } from 'node:crypto';
import type { ByteTransport, CloseReason } from '../../src/core/ble/transport';
import { buildFrame, FrameParser } from '../../src/core/ble/xbee-frame';
import { SRP_G, SRP_N, SRP_N_LEN, sha256, srpK } from '../../src/core/ble/srp';
import { bigIntToBytes, bytesToBigInt, modPow } from '../../src/core/util/bigint';
import { bytesEqual, concatBytes, fromHex, utf8 } from '../../src/core/util/bytes';
import { Listeners, type Unsubscribe } from '../../src/core/util/emitter';

export const FIRMWARE_SALT = fromHex('28513497');
export const FIRMWARE_VERIFIER = bytesToBigInt(
  fromHex(
    '6567694B0CA9ADCED8D5B2B0015718D1E2637B86E3E178E029936A078926C2B0' +
      '259F6833E1E1932E4485F48865FB6B76EC6E847A7272C77A8C27DD7DF94E44DC' +
      'A99A6E3937FBB8D05BBB4E4A8C4CB221C14D15CD004139C77B6FE0C8AF2932D8' +
      '6D4411D507FC52AFD5877D6E8529AEE7FB931F10944BC0D058FB246D0DE071DB',
  ),
);

export interface FakeXBeeOptions {
  /** Max bytes per indication; each indication gets a random size in [1, max]. */
  maxIndication?: number;
  /** Reject GATT writes longer than this (Windows-like behaviour). */
  maxWrite?: number;
  /** Relay payload appended in the *same* indication right after unlock step 4. */
  payloadAfterUnlock?: Uint8Array;
  /** 1-based index of a write that fails. */
  failWriteAt?: number;
  /** Deterministic indication sizes. */
  seed?: number;
}

const min = (x: bigint) => bigIntToBytes(x);

export class FakeXBee implements ByteTransport {
  readonly id = 'fake-xbee';
  readonly name = 'MLogger_TEST';
  /** Relay payloads received by the "MCU". */
  readonly relayed: Uint8Array[] = [];
  onRelay: (payload: Uint8Array) => void = () => {};
  writes: Uint8Array[] = [];

  private open_ = false;
  private readonly dataL = new Listeners<[Uint8Array]>();
  private readonly closeL = new Listeners<[CloseReason]>();
  private readonly parser = new FrameParser();
  private decIn: Decipheriv | null = null;
  private encOut: Cipheriv | null = null;
  private srp: { A: bigint; b: bigint; B: bigint } | null = null;
  private outQueue: Uint8Array[] = [];
  private flushing = false;
  private corruptNextOut = false;
  private rng: () => number;
  private readonly opts: FakeXBeeOptions;

  constructor(opts: FakeXBeeOptions = {}) {
    this.opts = opts;
    let s = opts.seed ?? 1;
    this.rng = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  get isOpen() {
    return this.open_;
  }

  async open(): Promise<void> {
    this.open_ = true;
  }

  onData(cb: (b: Uint8Array) => void): Unsubscribe {
    return this.dataL.add(cb);
  }

  onClose(cb: (r: CloseReason) => void): Unsubscribe {
    return this.closeL.add(cb);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.closeL.emit('local');
  }

  /** Simulate the peripheral dropping the connection. */
  disconnect(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.closeL.emit('remote');
  }

  /** Flip one byte of the next outgoing indication (simulates a desynchronised stream). */
  corruptNext(): void {
    this.corruptNextOut = true;
  }

  get unlocked(): boolean {
    return this.encOut !== null;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.open_) throw new Error('not connected');
    const n = this.writes.length + 1;
    if (this.opts.failWriteAt === n) throw new Error('GATT write failed (injected)');
    if (this.opts.maxWrite !== undefined && chunk.length > this.opts.maxWrite) {
      throw new Error(`write of ${chunk.length} bytes exceeds ${this.opts.maxWrite}`);
    }
    this.writes.push(chunk.slice());
    const plain = this.decIn ? new Uint8Array(this.decIn.update(chunk)) : chunk;
    this.parser.push(plain);
    for (let f = this.parser.next(); f; f = this.parser.next()) await this.handleFrame(f);
  }

  /** "MCU" → BLE: emit a relay output frame. */
  sendRelay(payload: Uint8Array): void {
    if (!this.encOut) throw new Error('not unlocked');
    const frame = buildFrame(concatBytes(Uint8Array.of(0xad, 0x00), payload));
    this.enqueue(new Uint8Array(this.encOut.update(frame)));
  }

  private async handleFrame(f: Uint8Array): Promise<void> {
    const type = f[0];
    if (type === 0x2c) return this.handleUnlock(f);
    if (type === 0x2d && this.encOut) {
      const payload = f.slice(3);
      this.relayed.push(payload);
      this.onRelay(payload);
    }
  }

  private async handleUnlock(f: Uint8Array): Promise<void> {
    const step = f[1];
    if (step === 1) {
      const A = bytesToBigInt(f.subarray(2, 2 + SRP_N_LEN));
      if (A % SRP_N === 0n || f.length !== 2 + SRP_N_LEN) return this.enqueuePlain(Uint8Array.of(0xac, 0x80));
      const b = bytesToBigInt(randomBytes(32));
      const k = await srpK();
      const B = (k * FIRMWARE_VERIFIER + modPow(SRP_G, b, SRP_N)) % SRP_N;
      this.srp = { A, b, B };
      return this.enqueuePlain(concatBytes(Uint8Array.of(0xac, 0x02), FIRMWARE_SALT, bigIntToBytes(B, SRP_N_LEN)));
    }
    if (step === 3 && this.srp) {
      const { A, b, B } = this.srp;
      const u = bytesToBigInt(await sha256(min(A), min(B)));
      const S = modPow(A * modPow(FIRMWARE_VERIFIER, u, SRP_N), b, SRP_N);
      const K = await sha256(min(S));
      const hN = await sha256(min(SRP_N));
      const hG = await sha256(min(SRP_G));
      const hXor = hN.map((v, i) => v ^ hG[i]!);
      const M1 = await sha256(hXor, await sha256(utf8('apiservice')), FIRMWARE_SALT, min(A), min(B), K);
      if (!bytesEqual(M1, f.subarray(2))) return this.enqueuePlain(Uint8Array.of(0xac, 0x82));
      const M2 = await sha256(min(A), M1, K);
      const txNonce = new Uint8Array(randomBytes(12)); // client → XBee
      const rxNonce = new Uint8Array(randomBytes(12)); // XBee → client
      const ctr1 = Uint8Array.of(0, 0, 0, 1);
      this.decIn = createDecipheriv('aes-256-ctr', K, concatBytes(txNonce, ctr1));
      this.encOut = createCipheriv('aes-256-ctr', K, concatBytes(rxNonce, ctr1));
      let out = buildFrame(concatBytes(Uint8Array.of(0xac, 0x04), M2, txNonce, rxNonce));
      if (this.opts.payloadAfterUnlock) {
        const frame = buildFrame(concatBytes(Uint8Array.of(0xad, 0x00), this.opts.payloadAfterUnlock));
        out = concatBytes(out, new Uint8Array(this.encOut.update(frame)));
        this.outQueue.push(out); // one indication: plaintext step 4 + ciphertext
        this.flush();
        return;
      }
      return this.enqueue(out);
    }
    return this.enqueuePlain(Uint8Array.of(0xac, 0x84));
  }

  private enqueuePlain(frameData: Uint8Array): void {
    this.enqueue(buildFrame(frameData));
  }

  /** Split into random-size indications, delivered asynchronously in order. */
  private enqueue(bytes: Uint8Array): void {
    const max = this.opts.maxIndication ?? 244;
    for (let i = 0; i < bytes.length; ) {
      const n = Math.max(1, Math.min(bytes.length - i, Math.ceil(this.rng() * max)));
      this.outQueue.push(bytes.slice(i, i + n));
      i += n;
    }
    this.flush();
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    const step = () => {
      const next = this.outQueue.shift();
      if (!next || !this.open_) {
        this.flushing = false;
        return;
      }
      if (this.corruptNextOut) {
        next[Math.floor(next.length / 2)]! ^= 0x5a;
        this.corruptNextOut = false;
      }
      this.dataL.emit(next);
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }
}
