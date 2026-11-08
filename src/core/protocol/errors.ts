/** Error codes defined by protocol v4 §6, plus client-side codes. */
export type ProtocolErrorCode =
  | 'unknown_command'
  | 'invalid_params'
  | 'out_of_range'
  | 'unsupported_transport'
  | 'busy'
  | 'rtc_unset'
  | 'internal_error'
  | 'parse_error' // firmware replied with id 0: it could not parse our line
  | (string & {});

/** The device answered with an `error` object. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly command: string;

  constructor(command: string, code: ProtocolErrorCode, message: string) {
    super(`${command}: ${code}${message ? ` (${message})` : ''}`);
    this.name = 'ProtocolError';
    this.code = code;
    this.command = command;
  }
}

export class CommandTimeoutError extends Error {
  readonly command: string;

  constructor(command: string, ms: number) {
    super(`${command}: no response within ${ms} ms`);
    this.name = 'CommandTimeoutError';
    this.command = command;
  }
}

/** The link to the device closed while the request was pending. */
export class ClientClosedError extends Error {
  constructor(message = 'connection closed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ClientClosedError';
  }
}

export class AbortedError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export class DumpStallError extends Error {
  readonly received: number;
  readonly expected: number;

  constructor(received: number, expected: number, ms: number) {
    super(`dump stalled: ${received}/${expected} bytes, nothing for ${ms} ms`);
    this.name = 'DumpStallError';
    this.received = received;
    this.expected = expected;
  }
}

export class DumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpError';
  }
}
