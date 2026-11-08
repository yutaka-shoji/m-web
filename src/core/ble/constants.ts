/**
 * XBee 3 BLE "API service" constants as used by M-Logger.
 * Source: et0614/mlogger software/python/mlogger/factory_test.py (BLE section) and
 * firmware/mlogger_main.X/xbee_controller.c.
 */

export const XBEE_SERVICE_UUID = '53da53b9-0447-425a-b9ea-9837505eb59a';
/** API Request characteristic: written by the client (write with response). */
export const XBEE_REQUEST_CHAR_UUID = '7dddca00-3e05-4651-9254-44074792c590';
/** API Response characteristic: indications from the XBee. */
export const XBEE_RESPONSE_CHAR_UUID = 'f9279ee9-2cd0-410c-81cc-adf11e4e5aea';

/** Default advertised-name prefix of M-Logger units (the name is the XBee BI value). */
export const MLOGGER_NAME_PREFIX = 'MLogger_';

/**
 * Chooser filters. The XBee does not advertise its API service UUID, so only names work.
 * After a first connection macOS shows the module's cached GAP name ("XBee3 Zigbee")
 * instead of the advertised BI name, so XBee 3 names are accepted too (verified on hardware,
 * docs/hw-notes.md). The real M-Logger name comes from `hello` after connecting.
 */
export const MLOGGER_SCAN_FILTERS: BluetoothLEScanFilter[] = [
  { namePrefix: MLOGGER_NAME_PREFIX },
  { namePrefix: 'XBee3' },
];

/** SRP identity fixed by the XBee firmware. */
export const XBEE_SRP_USER = 'apiservice';
/** BLE password programmed into every M-Logger (public in the reference repository). */
export const MLOGGER_BLE_PASSWORD = 'ml_pass';

export const FRAME_UNLOCK_REQ = 0x2c;
export const FRAME_UNLOCK_RESP = 0xac;
export const FRAME_RELAY_REQ = 0x2d;
export const FRAME_RELAY_OUT = 0xad;
/** User Data Relay interface id of the XBee serial port (the M-Logger MCU). */
export const RELAY_IF_SERIAL = 0x00;

export const UNLOCK_ERROR_TEXT: Readonly<Record<number, string>> = {
  0x80: 'unable to offer B (bad A)',
  0x81: 'incorrect payload length',
  0x82: 'bad proof of key (password mismatch)',
  0x83: 'resource allocation error',
  0x84: 'step out of sequence',
};

/**
 * Bytes per GATT write. Web Bluetooth does not expose the negotiated MTU, and Chrome on
 * Windows has been reported to reject writes above 20 bytes, so 20 is the safe default.
 */
export const DEFAULT_WRITE_CHUNK = 20;

/**
 * Max payload bytes per outgoing User Data Relay frame. The firmware's XBee RX buffer is
 * 256 bytes; a command line (≤ 511 bytes) is split across several relay frames.
 */
export const MAX_RELAY_PAYLOAD = 200;
