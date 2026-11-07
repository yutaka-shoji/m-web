# Hardware notes

Measurements against real M-Loggers, used to fix protocol timing constants.
Raw reports: `tests/hw/out/` (git-ignored; contain device identifiers).

## 2026-11-07 — P2 smoke (read-only commands)

Environment: macOS (Apple Silicon), Google Chrome 156, Web Bluetooth.
Devices: 3 × M-Logger, firmware 4.0.1, idle (not logging).
Harness: `npm run dev` + `npm run hw:smoke` (Chrome launched via `open -na` with a throwaway
profile, device chooser answered through Puppeteer `page.waitForDevicePrompt()`).

| | MLogger_1499 | MLogger_1497 | MLogger_1465 |
|---|---|---|---|
| connect + unlock (20 B writes) | 2.7 s | 2.5 s | 2.3 s |
| of which SRP unlock | 1.61 s | 1.46 s | 1.42 s |
| unlock attempts | 1 | 1 | 1 |
| command round trip (hello … get_count) | 77–219 ms | 88–144 ms | 77–180 ms |
| battery | 3296 mV | 2702 mV | 2697 mV |
| flash records | 2861 | 2866 | 2972 |
| bad checksums / discarded bytes | 0 / 0 | 0 / 0 | 0 / 0 |

- All three connected at the same time; `hello` sent to all three concurrently: 216 ms total.
- GATT write chunk (MLogger_1499, `get_settings` round trip): 20 B → 104–195 ms;
  182 B → 43–46 ms (one 209 ms outlier); 240 B → 43–87 ms. Larger writes work on macOS Chrome
  (MTU or long write), unknown on Windows.
- `get_probe_info` is supported by firmware 4.0.1 (not in protocol_v4.md).
- No `ready` events within the ~5 s session (sent every 60 s when idle).

### Decisions

- Keep **20-byte writes** as the default: works everywhere, and command latency (~0.1–0.2 s)
  is not user-visible. Larger chunks only halve round trips; revisit if Windows testing shows a need.
- Keep the 300 ms gap between consecutive commands (no lost commands observed).
- Connect devices one at a time (ConnectGate); once connected, talking to several in parallel is fine.

## 2026-11-07 — P3 protocol client (MLogger_1499)

`npm run hw:smoke -- live`: set_time, BLE-only live logging (flash untouched) for 30 s, stop,
then a read-only download of the whole flash log with `runDump`.

- `start_logging` round trip 524 ms. 6 `smp` events in 30 s at the configured 5 s interval.
  The first sample carried only `g` with `wu:["g"]` (TH/CO2 probe warming up), later samples
  had `t/h/g/c`. Device `ts` vs PC arrival: ~1 s (whole-second timestamps + latency).
- Download: 2861 records, 3 blocks, 62 942 B in 26 s = **2.4 kB/s**, no retries, no bad
  checksums. Header JSON and binary arrived interleaved as expected.
- Flash timestamps are **not monotonic** across the log (earlier sessions with clock resets);
  keep write order in exports, do not sort.

## 2026-11-07 — P4–P6 through the app UI

- `node scripts/hw-e2e.mjs`: 3 loggers added through the real “Add” button, live view on all,
  one GATT link dropped → automatic reconnect (BLE-only logging ends with the link, as the
  firmware does) → live view restarted → stop all. PASS.
- `node scripts/hw-e2e-recording.mjs 60`: BLE-only recording of 3 loggers for 2 × 60 s with a
  forced link drop in between; the recorder restarted logging on reconnect. ZIP export: 3 CSV
  files, 26–27 rows each at the configured 5 s interval, no gap over 20 s. PASS.
  (The velocity probes were switched off on these units, so MRT/PMV/PPD stay empty — same rule
  as the official app; an assumed air speed can be enabled in the settings.)
- `node scripts/perf-demo.mjs` (8 demo loggers × 24 h × 1 Hz preloaded, live data flowing):
  no long task > 50 ms when switching ranges (10 min … all), hovering, or changing clo/met;
  p95 frame 18 ms, worst 35 ms, heap ≈ 90–115 MB. (Before the allocation-free decimation and the
  frame-budgeted scheduler, 24 h ranges produced 150–180 ms tasks.)

### Chooser names on macOS

After the first connection, macOS shows M-Loggers in the Web Bluetooth chooser by the XBee's
cached GAP name **"XBee3 Zigbee"** instead of the advertised `MLogger_xxxx`, so a
`namePrefix: 'MLogger_'` filter alone finds nothing. The API service UUID is not advertised
(a `services` filter finds nothing either). The app therefore filters on
`namePrefix: 'MLogger_'` **or** `namePrefix: 'XBee3'`, and shows the real name from `hello`.

### Environment note

A Node process started from the Claude Code shell is killed by macOS TCC as soon as it touches
CoreBluetooth (`NSBluetoothAlwaysUsageDescription` missing in the responsible process). Chrome
launched through LaunchServices is its own responsible process, so hardware tests run in Chrome.

## 2026-11-08 — reconnecting after a long connection (Chrome on macOS)

Reported: after “Simulate link loss” on a real logger, the card stayed “reconnecting” forever.
The earlier check (`hw-e2e.mjs`) had dropped the link ~15 s after connecting and passed.

- bluetoothd logs (`log show --predicate 'process == "bluetoothd"'`) showed no “App connecting” for
  the dropped logger after the drop: the retries never reached the OS.
- Cause: Chrome's macOS adapter removes a device that is neither connected nor seen advertising
  within ~3 minutes (polled every 0.5 s). A link that drops after being up longer than that leaves
  the device out of Chrome's cache at once, and every `gatt.connect()` rejects immediately with
  `NetworkError: Bluetooth Device is no longer in range.` Only a scan brings it back.
- Fix: `DeviceNotInRangeError` → `conn.notInRange` (“Not found”). “Find and reconnect” opens the
  device chooser; its scan refreshes Chrome's cache, and every lost logger is retried right after.
  With `--enable-experimental-web-platform-features`, `watchAdvertisements()` exists and the app
  reconnects by itself on the first advertisement. A hello timeout on a logger that answered before
  is now treated as a link problem (it used to be reported as v3 firmware).
- `node scripts/hw-e2e-lost.mjs` (live view, 200 s, then drop):
  - manual, 1 logger: flagged within ~1 s (error text as above); online 5 s after picking it again.
  - manual, 3 loggers, 2 dropped: one pick in the chooser brought both back within 6 s.
  - auto (flag on), 1 logger: online 8 s after the drop, no user action.

### Test environment: one Chrome at a time

With the user's own Chrome running, a second Chrome instance (the test profile) received no BLE
advertisements at all: bluetoothd ran its scan with `FG:0` (background) and logged
“Error getting Application State for com.google.Chrome”. Scans that worked earlier had `FG:1`.
Quit other Chrome instances before running the hardware scripts.
