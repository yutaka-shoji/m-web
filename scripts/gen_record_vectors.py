"""Golden vectors for the 22-byte flash record, packed with Python's struct (stdlib only).

Decoding rules follow et0614/mlogger software/dist_user/python_tools/load_data.py
(`decode_record`), the official USB download tool.

Usage:
    python3 -I scripts/gen_record_vectors.py > tests/fixtures/record-vectors.json
"""
import json
import struct
import sys

FMT = "<BIBIhhHHHH"
FLAGS = {"l": 1 << 0, "t": 1 << 1, "g": 1 << 2, "h": 1 << 3, "v": 1 << 4, "vv": 1 << 5, "c": 1 << 6}

rows = [
    # gen, ts, flags, ill(x10), t(x100), g(x100), h(x100), wind(x10000), volt, co2
    (1, 1767225600, 0b1111111, 4205, 2345, 2410, 5520, 1234, 2350, 425),
    (2, 1794042000, 0b1001110, 0, -1234, -500, 10000, 0, 0, 5000),
    (254, 4294967295, 0, 999999, 32767, -32768, 65535, 65535, 65535, 65535),
    (0, 1767225605, 0b0010001, 999999, 0, 0, 0, 65535, 0, 0),
]

out = []
for gen, ts, flags, ill, t, g, h, w, vv, c in rows:
    raw = struct.pack(FMT, gen, ts, flags, ill, t, g, h, w, vv, c)
    assert len(raw) == 22
    out.append({
        "hex": raw.hex(),
        "expected": {
            "gen": gen,
            "ts": ts,
            "l": ill / 10.0 if flags & FLAGS["l"] else None,
            "t": t / 100.0 if flags & FLAGS["t"] else None,
            "g": g / 100.0 if flags & FLAGS["g"] else None,
            "h": h / 100.0 if flags & FLAGS["h"] else None,
            "v": w / 10000.0 if flags & FLAGS["v"] else None,
            "vv": vv if flags & FLAGS["vv"] else None,
            "c": c if flags & FLAGS["c"] else None,
        },
    })

json.dump(out, sys.stdout, indent=2)
print()
