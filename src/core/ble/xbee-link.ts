/**
 * XBee 3 BLE API link: frame codec + SRP unlock + AES-256-CTR + User Data Relay.
 *
 * Byte-level reference: et0614/mlogger software/python/mlogger/factory_test.py
 * (`XBeeBleLink`). Differences: outgoing lines are split into ≤200-byte relay frames,
 * the cipher switch happens synchronously when unlock step 4 is parsed (so encrypted bytes
 * in the same indication are decoded correctly), and stream desync is detected.
 */
import {
  DEFAULT_WRITE_CHUNK,
  FRAME_RELAY_OUT,
  FRAME_RELAY_REQ,
  FRAME_UNLOCK_REQ,
  FRAME_UNLOCK_RESP,
  MAX_RELAY_PAYLOAD,
  MLOGGER_BLE_PASSWORD,
  RELAY_IF_SERIAL,
  UNLOCK_ERROR_TEXT,
  XBEE_SRP_USER,
} from './constants';
import { CtrStream } from './ctr-stream';
import { cryptoRandomBytes, SrpClient, type RandomBytes } from './srp';
import type { ByteTransport } from './transport';
import { buildFrame, FrameParser } from './xbee-frame';
import { bytesEqual } from '../util/bytes';
import { Listeners, type Unsubscribe } from '../util/emitter';

export type LinkErrorKind =
  | 'disconnected'
  | 'write_failed'
  | 'desync'
  | 'unlock_failed'
  | 'unlock_timeout'
  | 'closed';

export class LinkError extends Error {
  readonly kind: LinkErrorKind;

  constructor(message: string, kind: LinkErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LinkError';
    this.kind = kind;
  }
}

export class UnlockError extends LinkError {
  readonly retryable: boolean;
  readonly code: number | undefined;

  constructor(message: string, kind: 'unlock_failed' | 'unlock_timeout', retryable: boolean, code?: number) {
    super(message, kind);
    this.name = 'UnlockError';
    this.retryable = retryable;
    this.code = code;
  }
}

export interface LinkStats {
  writeChunk: number;
  txFrames: number;
  txBytes: number;
  rxBytes: number;
  rxFrames: number;
  badChecksums: number;
  discardedBytes: number;
  lastRxAt: number;
  unlockMs: number;
  unlockAttempts: number;
}

/** What the protocol layer sees: a line-oriented, encrypted pipe to the M-Logger MCU. */
export interface PayloadLink {
  readonly transportId: string;
  readonly closed: boolean;
  readonly stats: Readonly<LinkStats>;
  /** Send bytes (normally one JSON line incl. "\n") to the MCU serial port. */
  sendLine(line: Uint8Array): Promise<void>;
  /** Relay payloads from the MCU, in order. Payloads arriving before the first listener are buffered. */
  onPayload(cb: (bytes: Uint8Array) => void): Unsubscribe;
  onClose(cb: (err: LinkError) => void): Unsubscribe;
  close(reason?: string): void;
}

export interface XBeeLinkOptions {
  password?: string;
  /** Bytes per GATT write. */
  writeChunk?: number;
  unlockStepTimeoutMs?: number;
  unlockAttempts?: number;
  randomBytes?: RandomBytes;
  now?: () => number;
  /** Stream anomalies (bad checksum / 32 discarded bytes) tolerated within `desyncWindowMs`. */
  desyncThreshold?: number;
  desyncWindowMs?: number;
}

const DEFAULTS = {
  password: MLOGGER_BLE_PASSWORD,
  writeChunk: DEFAULT_WRITE_CHUNK,
  unlockStepTimeoutMs: 5000,
  unlockAttempts: 2,
  randomBytes: cryptoRandomBytes,
  now: () => Date.now(),
  desyncThreshold: 2,
  desyncWindowMs: 10_000,
} satisfies Required<XBeeLinkOptions>;

/** Unlock the XBee over an opened transport and return the encrypted relay link. */
export async function openXBeeLink(transport: ByteTransport, opts: XBeeLinkOptions = {}): Promise<PayloadLink> {
  const link = new XBeeLink(transport, opts);
  try {
    await link.unlock();
  } catch (err) {
    link.close('unlock failed');
    throw err;
  }
  return link;
}

const MAX_EARLY_PAYLOADS = 64;

class XBeeLink implements PayloadLink {
  private readonly opts: Required<XBeeLinkOptions>;
  private readonly parser = new FrameParser();
  private rx: CtrStream | null = null;
  private tx: CtrStream | null = null;
  private state: 'unlocking' | 'open' | 'closed' = 'unlocking';
  private closeError: LinkError | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private unlockWaiter: { resolve(f: Uint8Array): void; reject(e: Error): void } | null = null;
  private pendingStep4: { expectedM2: Uint8Array; key: CryptoKey } | null = null;
  private switchedToCipher = false;
  private readonly payloadListeners = new Listeners<[Uint8Array]>();
  private readonly closeListeners = new Listeners<[LinkError]>();
  private early: Uint8Array[] = [];
  private readonly unsubs: Unsubscribe[] = [];
  private anomalies: number[] = [];
  private seenBad = 0;
  private seenDiscarded = 0;
  readonly stats: LinkStats;
  private readonly transport: ByteTransport;

  constructor(transport: ByteTransport, opts: XBeeLinkOptions) {
    this.transport = transport;
    this.opts = { ...DEFAULTS, ...opts };
    this.stats = {
      writeChunk: this.opts.writeChunk,
      txFrames: 0,
      txBytes: 0,
      rxBytes: 0,
      rxFrames: 0,
      badChecksums: 0,
      discardedBytes: 0,
      lastRxAt: 0,
      unlockMs: 0,
      unlockAttempts: 0,
    };
    this.unsubs.push(transport.onData((b) => this.onIndication(b)));
    this.unsubs.push(
      transport.onClose((reason) =>
        this.fail(
          new LinkError(reason === 'remote' ? 'device disconnected' : 'transport closed', 'disconnected'),
        ),
      ),
    );
  }

  get transportId(): string {
    return this.transport.id;
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  // ---------------------------------------------------------------- unlock

  async unlock(): Promise<void> {
    const t0 = this.opts.now();
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.opts.unlockAttempts; attempt++) {
      this.stats.unlockAttempts = attempt;
      try {
        await this.unlockOnce();
        this.stats.unlockMs = this.opts.now() - t0;
        return;
      } catch (err) {
        lastErr = err;
        if (this.state === 'closed' || !(err instanceof UnlockError) || !err.retryable) throw err;
        await new Promise((r) => setTimeout(r, 400));
        this.parser.reset();
      }
    }
    throw lastErr;
  }

  private async unlockOnce(): Promise<void> {
    const srp = new SrpClient(XBEE_SRP_USER, this.opts.password, this.opts.randomBytes);
    const step1 = new Uint8Array(2 + 128);
    step1[0] = FRAME_UNLOCK_REQ;
    step1[1] = 1;
    step1.set(srp.aBytes(), 2);
    const r2 = await this.unlockRequest(step1, 'step 1');
    if (r2[1] !== 2) throw unlockErrorFromCode(r2[1]);
    if (r2.length < 134) throw new UnlockError('short unlock step-2 frame', 'unlock_failed', true);

    const res = await srp.processChallenge(r2.slice(2, 6), r2.slice(6, 134));
    if (!res) throw new UnlockError('invalid B from device', 'unlock_failed', true);
    // Everything needed to verify step 4 and switch ciphers synchronously is prepared now.
    this.pendingStep4 = { expectedM2: res.expectedM2, key: await CtrStream.importKey(res.K) };

    const step3 = new Uint8Array(2 + res.M1.length);
    step3[0] = FRAME_UNLOCK_REQ;
    step3[1] = 3;
    step3.set(res.M1, 2);
    const r4 = await this.unlockRequest(step3, 'step 3');
    this.pendingStep4 = null;
    if (r4[1] !== 4) throw unlockErrorFromCode(r4[1]);
    if (this.state !== 'open') throw new UnlockError('device proof (M2) mismatch', 'unlock_failed', false);
  }

  private unlockRequest(data: Uint8Array, label: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unlockWaiter = null;
        reject(new UnlockError(`no response to unlock ${label}`, 'unlock_timeout', true));
      }, this.opts.unlockStepTimeoutMs);
      this.unlockWaiter = {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.sendFrame(data).catch((e: unknown) => {
        const w = this.unlockWaiter;
        this.unlockWaiter = null;
        w?.reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  // ---------------------------------------------------------------- receive

  private onIndication(bytes: Uint8Array): void {
    if (this.state === 'closed') return;
    this.stats.rxBytes += bytes.length;
    this.stats.lastRxAt = this.opts.now();
    if (this.rx) this.decryptAndFeed(bytes);
    else this.feed(bytes);
  }

  private decryptAndFeed(bytes: Uint8Array): void {
    // Offsets are assigned now (arrival order); results are fed in the same order.
    this.rx!.process(bytes).then(
      (plain) => this.feed(plain),
      (err: unknown) => this.fail(new LinkError('decryption failed', 'desync', { cause: err })),
    );
  }

  private feed(bytes: Uint8Array): void {
    if (this.state === 'closed') return;
    this.parser.push(bytes);
    for (;;) {
      const frame = this.parser.next();
      if (!frame) break;
      this.handleFrame(frame);
      if (this.switchedToCipher) {
        // Bytes after unlock step 4 in the same indication are already ciphertext.
        this.switchedToCipher = false;
        const rest = this.parser.takeRemaining();
        if (rest.length > 0) this.decryptAndFeed(rest);
        break;
      }
    }
    this.checkDesync();
  }

  private handleFrame(frame: Uint8Array): void {
    this.stats.rxFrames += 1;
    const type = frame[0];
    if (type === FRAME_UNLOCK_RESP) {
      if (frame[1] === 4 && this.pendingStep4 && frame.length >= 58) {
        const { expectedM2, key } = this.pendingStep4;
        this.pendingStep4 = null;
        if (bytesEqual(frame.subarray(2, 34), expectedM2)) {
          // TX/RX named from the client's side: send with the TX nonce, receive with the RX nonce.
          this.tx = CtrStream.withKey(key, frame.subarray(34, 46));
          this.rx = CtrStream.withKey(key, frame.subarray(46, 58));
          this.state = 'open';
          this.switchedToCipher = true;
        }
      }
      const w = this.unlockWaiter;
      this.unlockWaiter = null;
      w?.resolve(frame);
      return;
    }
    if (type === FRAME_RELAY_OUT && frame.length >= 2 && this.state === 'open') {
      const payload = frame.subarray(2);
      if (this.payloadListeners.size > 0) this.payloadListeners.emit(payload);
      else if (this.early.length < MAX_EARLY_PAYLOADS) this.early.push(payload);
    }
    // Other frame types (e.g. 0x89 transmit status) carry nothing for us.
  }

  private checkDesync(): void {
    const bad = this.parser.badChecksums;
    const discarded = this.parser.discardedBytes;
    this.stats.badChecksums = bad;
    this.stats.discardedBytes = discarded;
    if (!this.rx) {
      this.seenBad = bad;
      this.seenDiscarded = discarded;
      return;
    }
    const score = bad - this.seenBad + Math.floor((discarded - this.seenDiscarded) / 32);
    if (score <= 0) return;
    this.seenBad = bad;
    this.seenDiscarded = discarded - ((discarded - this.seenDiscarded) % 32);
    const now = this.opts.now();
    for (let i = 0; i < score; i++) this.anomalies.push(now);
    this.anomalies = this.anomalies.filter((t) => now - t <= this.opts.desyncWindowMs);
    if (this.anomalies.length >= this.opts.desyncThreshold) {
      this.fail(new LinkError('encrypted stream out of sync', 'desync'));
    }
  }

  // ---------------------------------------------------------------- send

  private sendFrame(data: Uint8Array): Promise<void> {
    if (this.state === 'closed') return Promise.reject(this.closeError ?? new LinkError('link closed', 'closed'));
    const raw = buildFrame(data);
    // Encrypt now so TX keystream offsets follow call order; writes are serialised below.
    const bytesP = this.tx ? this.tx.process(raw) : Promise.resolve(raw);
    this.stats.txFrames += 1;
    this.stats.txBytes += raw.length;
    const run = this.writeTail.then(async () => {
      const bytes = await bytesP;
      const n = this.opts.writeChunk;
      for (let i = 0; i < bytes.length; i += n) {
        if (this.state === 'closed') throw this.closeError ?? new LinkError('link closed', 'closed');
        await this.transport.write(bytes.subarray(i, Math.min(i + n, bytes.length)));
      }
    });
    this.writeTail = run.catch(() => undefined);
    return run.catch((err: unknown) => {
      const e = err instanceof LinkError ? err : new LinkError('GATT write failed', 'write_failed', { cause: err });
      // A partially written encrypted frame leaves the device's keystream position unknown.
      this.fail(e);
      throw e;
    });
  }

  async sendLine(line: Uint8Array): Promise<void> {
    if (this.state !== 'open') throw this.closeError ?? new LinkError('link not open', 'closed');
    const writes: Promise<void>[] = [];
    for (let i = 0; i < line.length; i += MAX_RELAY_PAYLOAD) {
      const seg = line.subarray(i, Math.min(i + MAX_RELAY_PAYLOAD, line.length));
      const data = new Uint8Array(3 + seg.length);
      data[0] = FRAME_RELAY_REQ;
      data[1] = 0x00; // frame id 0: no transmit status
      data[2] = RELAY_IF_SERIAL;
      data.set(seg, 3);
      writes.push(this.sendFrame(data));
    }
    await Promise.all(writes);
  }

  // ---------------------------------------------------------------- lifecycle

  onPayload(cb: (bytes: Uint8Array) => void): Unsubscribe {
    const unsub = this.payloadListeners.add(cb);
    if (this.early.length > 0) {
      const pending = this.early;
      this.early = [];
      for (const p of pending) cb(p);
    }
    return unsub;
  }

  onClose(cb: (err: LinkError) => void): Unsubscribe {
    if (this.state === 'closed' && this.closeError) {
      const err = this.closeError;
      queueMicrotask(() => cb(err));
      return () => {};
    }
    return this.closeListeners.add(cb);
  }

  close(reason = 'closed by client'): void {
    this.fail(new LinkError(reason, 'closed'));
  }

  private fail(err: LinkError): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeError = err;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    const w = this.unlockWaiter;
    this.unlockWaiter = null;
    w?.reject(err);
    this.transport.close();
    this.closeListeners.emit(err);
    this.closeListeners.clear();
    this.payloadListeners.clear();
    this.early = [];
  }
}

function unlockErrorFromCode(code: number | undefined): UnlockError {
  const c = code ?? -1;
  const text = UNLOCK_ERROR_TEXT[c] ?? `unexpected unlock response 0x${c.toString(16)}`;
  // 0x81 (payload length) would be our bug; everything else may succeed with a fresh attempt.
  return new UnlockError(`unlock rejected: ${text}`, 'unlock_failed', c !== 0x81, c);
}
