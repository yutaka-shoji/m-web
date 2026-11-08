import { describe, expect, it } from 'vitest';
import { LineDecoder } from '../../../src/core/protocol/line-decoder';
import { concatBytes, utf8 } from '../../../src/core/util/bytes';

describe('LineDecoder', () => {
  it('splits on \\n and \\r, skips empty lines, survives arbitrary chunking and split UTF-8', () => {
    const lines: string[] = [];
    const d = new LineDecoder((l) => lines.push(l));
    const text = '{"a":1}\r\n\n{"name":"会議室A"}\n{"b":2}\r';
    const bytes = utf8(text);
    for (let i = 0; i < bytes.length; i += 3) d.push(bytes.subarray(i, i + 3));
    expect(lines).toEqual(['{"a":1}', '{"name":"会議室A"}', '{"b":2}']);
  });

  it('switches to binary mode synchronously in the middle of a chunk', () => {
    const lines: string[] = [];
    const bin: Uint8Array[] = [];
    const d = new LineDecoder((l) => {
      lines.push(l);
      if (l.includes('"count"')) d.startBinary(5, (b) => bin.push(b.slice()));
    });
    d.push(concatBytes(utf8('{"id":1,"result":{"count":5}}\n'), Uint8Array.of(1, 10, 13, 4)));
    d.push(concatBytes(Uint8Array.of(5), utf8('{"event":"dump_end"}\n')));
    expect(concatBytes(...bin)).toEqual(Uint8Array.of(1, 10, 13, 4, 5)); // 0x0a/0x0d inside binary kept
    expect(lines).toEqual(['{"id":1,"result":{"count":5}}', '{"event":"dump_end"}']);
    expect(d.inBinaryMode).toBe(false);
  });

  it('drops over-long lines', () => {
    const lines: string[] = [];
    const d = new LineDecoder((l) => lines.push(l), 16);
    d.push(utf8('x'.repeat(40) + '\n{"ok":1}\n'));
    expect(d.overflows).toBe(1);
    expect(lines.at(-1)).toBe('{"ok":1}');
  });
});
