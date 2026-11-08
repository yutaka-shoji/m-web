# Guide

m-web connects a PC browser to **M-Logger** indoor-climate loggers over Bluetooth, showing and recording several loggers at once. Nothing to install; all data stays in this browser.

## What it does

- Connects to several M-Loggers at the same time and shows air temperature, relative humidity, globe temperature, air speed, illuminance and CO₂ live
- Computes the mean radiant temperature (MRT), PMV and PPD
- Records the values on this PC (in the browser) and exports CSV files
- Downloads the data stored in the logger's flash memory over Bluetooth and converts it to CSV
- Changes measurement intervals, start time, correction factors and the name; calibrates the CO₂ sensor; erases the device memory

## Requirements

| Item | Details |
|---|---|
| Browser | Desktop **Google Chrome** or **Microsoft Edge** (current). Safari, Firefox and phones are not supported |
| PC | Windows, macOS or ChromeOS with Bluetooth Low Energy |
| Loggers at once | Depends on the PC's Bluetooth adapter; about 5–7 as a rule of thumb (see “Connecting loggers” below) |
| M-Logger | **v4 or later** (units with a USB Type-C port). v3 and earlier units are not supported |
| Page | Served over HTTPS (or localhost during development) |

Version 4 of the M-Logger brought substantially new hardware and firmware updates through the USB port. This app uses the v4 protocol, so v3 and earlier units cannot be used for now.

On macOS you may be asked whether Google Chrome may use Bluetooth the first time. Choose **Allow** (change it later in System Settings > Privacy & Security > Bluetooth).

## Preparation

1. Switch the M-Logger on (the green LED blinks once per second).
2. Keep it within about 10 m of the PC; walls and metal weaken the signal.
3. Make sure it is **not connected to another device** such as the phone app — an M-Logger accepts one connection at a time.

The clock is set automatically when connecting (the clock of a logger that is already logging is left alone).

## Connecting loggers

1. Press **Add M-Logger** on the dashboard.
2. The browser lists nearby devices. Pick one and press **Pair** (or **Connect**).
3. After the unlock (about 1.5 s) and reading the settings, the card shows the logger name and battery voltage.
4. Repeat for more loggers. Connected loggers are not listed again.

How many loggers can be connected at the same time is set by the PC's Bluetooth adapter (with its driver and the OS), and the limit is rarely published. For a typical PC, **5–7 loggers** is a reasonable rule of thumb. Mice, keyboards, headphones and other Bluetooth devices use the same connection slots. If adding loggers leads to failed or frequently dropped connections, connect fewer or split them across PCs (tested: 3 loggers on a macOS PC with Apple silicon).

The chooser may show units as “MLogger_xxxx” or as **“XBee3 Zigbee”** (macOS remembers the radio module's own name after a first connection). Pick any of them — the real logger name appears on the card after connecting.

If a connection drops, the app keeps reconnecting (until it succeeds while recording or downloading, otherwise for up to 10 minutes).

### When a card says “Not found”

When a link drops after it has been up for more than a few minutes, the browser may lose track of the logger. Chrome on macOS in particular forgets devices it has not heard for about three minutes, so automatic reconnection cannot bring them back. The card then shows **Not found**.

1. Check that the logger is on and close enough to the PC.
2. Press **Find and reconnect** on the card or at the top of the dashboard.
3. Pick the logger when it appears in the chooser. The chooser's scan also brings back any other loggers that were lost.

> With `chrome://flags/#enable-experimental-web-platform-features` (Experimental Web Platform features) enabled in Chrome, lost loggers reconnect automatically as soon as their signal is received. It is an experimental feature and off by default.

> Without hardware at hand, **Try demo loggers** lets you explore the app with simulated data.

## Live view and readings

**Live view** on a card starts measuring and updates the card with every sample; **Live view on all** starts every connected logger. Live view does not save anything — use **Start recording** for that (next section).

| Display | Meaning |
|---|---|
| Number | Latest value. Quantities with longer intervals keep their last value until the next sample |
| — Warming up | The probe is starting: temperature/humidity/CO₂ appear about 25 s after the start, air speed after about 10 s |
| — Off | The quantity is switched off in the measurement settings |
| — Probe not connected | The probe does not answer; check its connection |
| Dimmed | No new values for a while |

CO₂ readings may need about an hour to settle after the logger was off (or not measuring) for more than 3 hours (firmware 4.0.1 and later handle this automatically).

### MRT, PMV and PPD

- **MRT** is derived from globe temperature, air temperature and air speed with the ISO 7726 equation for the M-Logger globe (38 mm, emissivity 0.95), using the larger of the natural and forced convection coefficients — the same method as the official app.
- **PMV and PPD** follow ISO 7730. Set clothing (clo) and metabolic rate (met) under **Comfort conditions** on the dashboard. Defaults: 1.0 clo, 1.1 met.
- They show “—” until air temperature, humidity, globe temperature and air speed have all been measured, and while a probe is warming up or disconnected. For loggers without air-speed measurement, set an **assumed air speed** in Settings (shown as “assumed air speed”).
- Conditions outside the ISO 7730 range of application (air 10–30 °C, MRT 10–40 °C, air speed 0–1 m/s, vapour pressure 0–2700 Pa, 0.8–4 met, 0–2 clo, PMV −2…+2) are marked **out of range**. Treat such values as indicative.

### Charts

Below the cards, each quantity has a chart with all loggers overlaid. Switch the range (10 min … 24 h, All), drag across a chart to zoom, and use **Back to live** to return. Hovering shows every logger's value at that time. Charts cover what arrived since this page was opened (up to 200 000 points per logger); older recordings are available as CSV on the Data page.

## Recording

1. In the recording bar at the top of the dashboard, optionally enter a **name**. If left empty, the start time is used, such as `2026-11-07_1830` (it also names the exported files).
2. Check **Also save on the logger’s flash (recommended)**.
3. Press **Start recording**. Every connected logger starts measuring and the values are saved in this browser.
4. Press **Stop** to finish. Choosing “Also stop logging on the devices” saves battery.

- Loggers connected during a recording join it automatically.
- With **save on flash**, the logger keeps logging if the PC link drops, and saving on the PC resumes after reconnecting (a logger shown as “Not found” is not saved on the PC until you bring it back with Find and reconnect); a later download of the device memory fills any gaps. Keeping Bluetooth output on drains the battery faster — use USB power for multi-day measurements.
- **Without** saving on flash, the logger stops measuring when the link drops (firmware behaviour); the app restarts it after reconnecting.
- Closing or reloading the page drops every connection; you are asked to confirm while recording. After a reload the app reports the interrupted recording, and **Continue recording** appends to it.

## Data and CSV

The **Data** page lists all recordings.

- A single-logger recording downloads as CSV; several loggers download as a ZIP with one CSV per logger plus `session.json` (devices and calculation conditions).
- **One CSV for all loggers (long format)** writes a single file with leading `device` and `hardware_id` columns.
- MRT, PMV and PPD are recomputed at download with the current comfort conditions.

### CSV columns

| Column | Content | Unit |
|---|---|---|
| `datetime` | Measurement time: the logger's timestamp in the PC's time zone, followed by the offset from UTC (e.g. `2026-11-07 18:00:00+09:00`) | — |
| `unix_time` | The same time as Unix seconds (UTC) | s |
| `t_dry[C]` | Air temperature | °C |
| `rh[%]` | Relative humidity | % |
| `t_glb[C]` | Globe temperature | °C |
| `velocity[m/s]` | Air speed | m/s |
| `illuminance[lx]` | Illuminance | lx |
| `co2[ppm]` | CO₂ | ppm |
| `mrt[C]` | Mean radiant temperature (derived) | °C |
| `pmv` | PMV (derived) | — |
| `ppd[%]` | PPD (derived) | % |
| `velocity_voltage[mV]` | Air-speed probe voltage (diagnostic, optional) | mV |

- An empty cell means “not measured at this time” (quantities have different intervals).
- Values keep the precision sent by the logger.
- Files are UTF-8 with BOM, so Excel shows Japanese names correctly.

## Downloading the device memory

Open **Details** on a card → “Device memory (flash)” to download what the logger stored itself.

- The record count and an estimated duration are shown. Transfer runs at about 2.4 kB/s: 10 000 records take about 1.5 minutes, a month at 60 s intervals (about 43 000 records) about 7 minutes.
- A logger that is logging cannot be downloaded; you are asked whether to stop it first.
- If you cancel or the link drops, **Resume download** continues from the last complete block of 1000 records.
- When done, press **Save CSV** (same columns, device-memory precision). Downloads are also listed on the Data page.
- Timestamps can jump backwards when the log spans periods with a reset clock; the CSV keeps the recorded order.

## Logger settings

The **Details** panel offers the following. Changes take effect once sent to the logger.

- **Measurement settings**: on/off and interval (1–86400 s) for temperature/humidity/globe/CO₂ (one group), air speed and illuminance, plus the start time. Switching off what you don't need saves battery — air speed in particular.
- **Correction factors**: corrected value = a × measured + b, applied in the logger to the recorded values. Current firmware does not apply the air-speed correction, so it cannot be edited.
- **CO₂ calibration**: run it where the CO₂ level is known, e.g. outdoors (about 420 ppm). Calibration to a reference takes about 35 s; the factory reset with calibration about 12 hours, during which the logger cannot measure. Not available while logging.
- **Rename**: up to 20 bytes (a Japanese character takes 3). Names starting with “MLogger_” are recommended. The new name appears in Bluetooth lists after the logger restarts.
- **Erase device memory**: requires typing the logger name. It cannot be undone — download what you need first.

## Tips for long measurements

- **Keep the PC awake**: sleep drops the Bluetooth connections. Disable sleep in the power settings (keep a laptop lid open).
- **Keep the window visible**: while recording or downloading, the app keeps the screen on (when visible). Receiving and saving continue in a background tab, but do not close the tab or let the browser discard it.
- **Plan for dropouts**: choose “save on flash” for long unattended measurements. Even if a logger stays “Not found” after a dropout, it keeps logging, and a later download of the device memory fills the gap.
- **Battery**: recording on the PC while also saving on flash keeps Bluetooth busy and drains the battery faster. Battery voltage is shown on the card and in Details, and turns vermilion when low. Use USB power for measurements of several days.
- **Browser storage**: the Data page shows how much is used. Save recordings as CSV and delete the ones you no longer need.

## Troubleshooting

| Symptom | What to check |
|---|---|
| The logger is not listed | Power and blinking LED, within 10 m, not connected to a phone or another PC (connected loggers are not listed), Bluetooth on |
| Only “XBee3 Zigbee” is listed | Normal — pick it; the real name appears after connecting |
| A card says “Not found” | The browser lost track of the logger. Check power and distance, press Find and reconnect and pick the logger in the chooser |
| Cannot connect / unlock fails | Power-cycle the logger and add it again. On Windows, toggling Bluetooth off and on may help |
| “Not supported (v3 or earlier)” | A v3 or earlier unit. The app supports v4 and later only (units with a USB Type-C port) |
| Values stay “—” | Warming up just after the start, or the quantity is switched off (Details → Measurement settings) |
| MRT/PMV show “—” | Not computable without air speed; set an assumed air speed in Settings |
| Frequent disconnects | Move closer and reduce obstacles; fewer simultaneous loggers can help |
| Recording stopped | Recordings without “save on flash” stop on the logger when the link drops; the app restarts them after reconnecting, but values during the outage are not kept |

## Bug reports and feature requests

Please report bugs and request features in [GitHub Issues](https://github.com/yutaka-shoji/m-web/issues) (posting needs a GitHub account). Under **New issue**, choose “Bug report” or “Feature request” to get a form. Questions about this app belong there, not with the M-Logger developer.

When reporting a bug, please include:

- What happened (any message shown) and the steps that led to it
- The app version (Settings → About), the OS, and the browser with its version
- The logger's firmware version (shown on the card and in Details)
- The traffic log (Settings → Diagnostics → Save traffic log). It is cleared when the page reloads, so save it right after the problem occurs

Issues are public. The traffic log contains logger names, hardware IDs and measured values — check that you are fine with publishing it before attaching it.

## Data and privacy

- Measurements and settings are stored only in this browser (IndexedDB, localStorage) and never sent to a server.
- Clearing the browser's site data deletes the recordings too — export what you need as CSV.
- Nothing is shared with other PCs or browsers.

## More information

- M-Logger official site: [mlogger.jp](https://www.mlogger.jp/) (product, manuals, firmware updates)
- Protocol and hardware: [et0614/mlogger](https://github.com/et0614/mlogger)
- Source code of this app: [yutaka-shoji/m-web](https://github.com/yutaka-shoji/m-web)

## Disclaimer

- The app is provided “as is”, without warranty of any kind, including accuracy, completeness and fitness for a particular purpose.
- The values shown, recorded or exported — including derived values such as MRT, PMV and PPD — are not guaranteed to be accurate. Check them yourself before using them for research, design or assessment.
- The author is not liable for any damage arising from using or being unable to use the app, including lost data and changes made to loggers (settings, erased device memory).
- M-Logger is a measuring instrument developed by Eisuke Togashi ([mlogger.jp](https://www.mlogger.jp/)). This app is unofficial: it is not affiliated with or endorsed by the M-Logger developer. Please do not contact the M-Logger developer about this app.
- The communication protocol and the record format follow [et0614/mlogger](https://github.com/et0614/mlogger) (CERN-OHL-P v2).
