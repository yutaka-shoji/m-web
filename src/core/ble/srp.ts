/**
 * SRP-6a client for the XBee 3 "BLE Unlock" handshake.
 *
 * Parameters are those of the XBee firmware as reverse-engineered in the reference client
 * (et0614/mlogger software/python/mlogger/factory_test.py, `SrpClient`):
 *   RFC 5054 1024-bit group, g = 2, SHA-256, integers hashed in MINIMAL big-endian form.
 *   k  = H(N | g)                    (g unpadded — not RFC 5054's PAD(g))
 *   x  = H(min(int(salt)) | H(I ":" P))
 *   u  = H(A | B)
 *   S  = (B − k·g^x)^(a + u·x) mod N,  K = H(S)
 *   M1 = H(H(N) xor H(g) | H(I) | salt(raw) | A | B | K),  M2 = H(A | M1 | K)
 * The x derivation reproduces the verifier burnt into M-Logger firmware (unit-tested).
 */
import { concatBytes, utf8 } from '../util/bytes';
import { bigIntToBytes, byteLength, bytesToBigInt, modPow } from '../util/bigint';

export const SRP_N = BigInt(
  '0xEEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3',
);
export const SRP_G = 2n;
export const SRP_N_LEN = 128;

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const data = parts.length === 1 ? parts[0]! : concatBytes(...parts);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

const min = (x: bigint) => bigIntToBytes(x);

/** Private key x = H(min(int(salt)) | H(user ":" password)). */
export async function srpX(user: string, password: string, salt: Uint8Array): Promise<bigint> {
  const inner = await sha256(utf8(user), utf8(':'), utf8(password));
  return bytesToBigInt(await sha256(min(bytesToBigInt(salt)), inner));
}

export async function srpK(): Promise<bigint> {
  return bytesToBigInt(await sha256(min(SRP_N), min(SRP_G)));
}

export interface SrpChallengeResult {
  /** Client proof to send in unlock step 3. */
  readonly M1: Uint8Array;
  /** Server proof expected in unlock step 4. */
  readonly expectedM2: Uint8Array;
  /** 32-byte session key = AES-256-CTR key after unlock. */
  readonly K: Uint8Array;
}

export type RandomBytes = (n: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export class SrpClient {
  readonly A: bigint;
  private readonly a: bigint;
  private readonly user: string;
  private readonly password: string;

  constructor(user: string, password: string, randomBytes: RandomBytes = cryptoRandomBytes) {
    this.user = user;
    this.password = password;
    // Redraw until A has the full 128-byte length (as the reference client does).
    for (;;) {
      const a = bytesToBigInt(randomBytes(32));
      if (a === 0n) continue;
      const A = modPow(SRP_G, a, SRP_N);
      if (byteLength(A) === SRP_N_LEN) {
        this.a = a;
        this.A = A;
        break;
      }
    }
  }

  /** A as the 128 bytes sent in unlock step 1. */
  aBytes(): Uint8Array {
    return bigIntToBytes(this.A, SRP_N_LEN);
  }

  /** Compute M1/M2/K from the step-2 salt and B. Returns null for an invalid B. */
  async processChallenge(salt: Uint8Array, bBytes: Uint8Array): Promise<SrpChallengeResult | null> {
    const B = bytesToBigInt(bBytes);
    if (B % SRP_N === 0n) return null;
    const Ab = min(this.A);
    const Bb = min(B);
    const u = bytesToBigInt(await sha256(Ab, Bb));
    if (u === 0n) return null;
    const k = await srpK();
    const x = await srpX(this.user, this.password, salt);
    const base = (((B - k * modPow(SRP_G, x, SRP_N)) % SRP_N) + SRP_N) % SRP_N;
    const S = modPow(base, this.a + u * x, SRP_N);
    const K = await sha256(min(S));
    const hN = await sha256(min(SRP_N));
    const hG = await sha256(min(SRP_G));
    const hXor = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hXor[i] = hN[i]! ^ hG[i]!;
    const M1 = await sha256(hXor, await sha256(utf8(this.user)), salt, Ab, Bb, K);
    const expectedM2 = await sha256(Ab, M1, K);
    return { M1, expectedM2, K };
  }
}
