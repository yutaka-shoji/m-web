import { describe, expect, it } from 'vitest';
import vectors from '../../fixtures/srp-vectors.json';
import { SRP_G, SRP_N, SrpClient, srpX } from '../../../src/core/ble/srp';
import { modPow } from '../../../src/core/util/bigint';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { FIRMWARE_SALT, FIRMWARE_VERIFIER } from '../../helpers/fake-xbee';

describe('SRP-6a (XBee BLE unlock)', () => {
  it('derives the verifier programmed into M-Logger firmware from "ml_pass"', async () => {
    const x = await srpX('apiservice', 'ml_pass', FIRMWARE_SALT);
    expect(modPow(SRP_G, x, SRP_N)).toBe(FIRMWARE_VERIFIER);
  });

  it('a different password gives a different verifier', async () => {
    const x = await srpX('apiservice', 'ml_pas', FIRMWARE_SALT);
    expect(modPow(SRP_G, x, SRP_N)).not.toBe(FIRMWARE_VERIFIER);
  });

  it('includes leading-zero edge cases in the vectors', () => {
    expect(vectors.cases.some((c) => c.B_leading_zero)).toBe(true);
    expect(vectors.cases.some((c) => c.S_leading_zero)).toBe(true);
  });

  it.each(vectors.cases.map((c, i) => [i, c] as const))(
    'matches the reference client byte-for-byte (case %i)',
    async (_i, c) => {
      const a = fromHex(c.a);
      const client = new SrpClient(vectors.user, vectors.password, () => a);
      expect(toHex(client.aBytes())).toBe(c.A);
      const res = await client.processChallenge(fromHex(c.salt), fromHex(c.B));
      expect(res).not.toBeNull();
      expect(toHex(res!.M1)).toBe(c.M1);
      expect(toHex(res!.expectedM2)).toBe(c.M2);
      expect(toHex(res!.K)).toBe(c.K);
    },
  );

  it('rejects B ≡ 0 (mod N)', async () => {
    const client = new SrpClient('apiservice', 'ml_pass');
    expect(await client.processChallenge(FIRMWARE_SALT, new Uint8Array(128))).toBeNull();
  });
});
