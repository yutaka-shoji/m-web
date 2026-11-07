import { describe, expect, it } from 'vitest';
import { openXBeeLink, LinkError, UnlockError } from '../../../src/core/ble/xbee-link';
import { concatBytes, utf8 } from '../../../src/core/util/bytes';
import { FakeXBee } from '../../helpers/fake-xbee';

const dec = new TextDecoder();

function collect(link: Awaited<ReturnType<typeof openXBeeLink>>) {
  const chunks: Uint8Array[] = [];
  link.onPayload((p) => chunks.push(p.slice()));
  return () => dec.decode(concatBytes(...chunks));
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('XBee BLE link over a fake XBee', () => {
  it('unlocks with the firmware verifier and uses 20-byte GATT writes', async () => {
    const xb = new FakeXBee({ maxWrite: 20, seed: 3 });
    await xb.open();
    const link = await openXBeeLink(xb);
    expect(xb.unlocked).toBe(true);
    expect(link.closed).toBe(false);
    expect(xb.writes.every((w) => w.length <= 20)).toBe(true);
    expect(link.stats.unlockAttempts).toBe(1);
    link.close();
  });

  it('sends long lines as ≤200-byte relay frames that reassemble exactly', async () => {
    const xb = new FakeXBee({ seed: 5 });
    await xb.open();
    const link = await openXBeeLink(xb);
    const line = `{"v":1,"id":7,"command":"set_settings","params":{"x":"${'a'.repeat(420)}"}}\n`;
    await link.sendLine(utf8(line));
    await link.sendLine(utf8('{"v":1,"id":8,"command":"hello"}\n'));
    expect(xb.relayed.every((p) => p.length <= 200)).toBe(true);
    expect(xb.relayed.length).toBeGreaterThanOrEqual(4);
    expect(dec.decode(concatBytes(...xb.relayed))).toBe(line + '{"v":1,"id":8,"command":"hello"}\n');
    link.close();
  });

  it('decrypts relay output split into random indication sizes', async () => {
    const xb = new FakeXBee({ maxIndication: 23, seed: 11 });
    await xb.open();
    const link = await openXBeeLink(xb);
    const text = collect(link);
    const lines = Array.from({ length: 30 }, (_, i) => `{"v":1,"event":"smp","ts":${1767225600 + i},"data":{"t":23.4}}\n`);
    for (const l of lines) xb.sendRelay(utf8(l));
    await until(() => text().length === lines.join('').length);
    expect(text()).toBe(lines.join(''));
    link.close();
  });

  it('keeps encrypted bytes that arrive in the same indication as unlock step 4', async () => {
    const early = '{"v":1,"event":"ready","ts":1767225600,"data":{"logging":false}}\n';
    const xb = new FakeXBee({ payloadAfterUnlock: utf8(early), seed: 2 });
    await xb.open();
    const link = await openXBeeLink(xb);
    const text = collect(link); // listener attached after unlock: buffered payload is delivered
    await until(() => text().length > 0);
    expect(text()).toBe(early);
    link.close();
  });

  it('fails unlock with code 0x82 when the password is wrong', async () => {
    const xb = new FakeXBee();
    await xb.open();
    const err = await openXBeeLink(xb, { password: 'wrong' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnlockError);
    expect((err as UnlockError).code).toBe(0x82);
  });

  it('closes the link when a GATT write fails after unlock', async () => {
    const xb = new FakeXBee({ seed: 4 });
    await xb.open();
    const link = await openXBeeLink(xb);
    const closed = new Promise<LinkError>((r) => link.onClose(r));
    xb['opts'].failWriteAt = xb.writes.length + 2;
    await expect(link.sendLine(utf8('{"v":1,"id":1,"command":"hello"}\n'))).rejects.toBeInstanceOf(LinkError);
    expect((await closed).kind).toBe('write_failed');
    expect(link.closed).toBe(true);
  });

  it('reports a remote disconnect', async () => {
    const xb = new FakeXBee();
    await xb.open();
    const link = await openXBeeLink(xb);
    const closed = new Promise<LinkError>((r) => link.onClose(r));
    xb.disconnect();
    expect((await closed).kind).toBe('disconnected');
    await expect(link.sendLine(utf8('x\n'))).rejects.toBeInstanceOf(LinkError);
  });

  it('detects a desynchronised stream and closes', async () => {
    const xb = new FakeXBee({ maxIndication: 300, seed: 9 });
    await xb.open();
    const link = await openXBeeLink(xb);
    collect(link);
    const closed = new Promise<LinkError>((r) => link.onClose(r));
    for (let i = 0; i < 4; i++) {
      xb.corruptNext();
      xb.sendRelay(utf8(`{"v":1,"event":"smp","ts":${i},"data":{}}\n`));
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await closed).kind).toBe('desync');
  });
});
