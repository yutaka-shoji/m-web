import type {
  BatteryResult,
  CalibrateCo2Params,
  Correction,
  CorrectionPatch,
  CountResult,
  HelloResult,
  ProbeInfo,
  Settings,
  SettingsPatch,
  StartLoggingParams,
} from './types';

type Empty = Record<string, never>;

/** Typed command table. `dump` is deliberately absent: it runs only through an exclusive lease. */
export interface CommandMap {
  hello: { params: void; result: HelloResult };
  get_battery: { params: void; result: BatteryResult };
  get_settings: { params: void; result: Settings };
  set_settings: { params: SettingsPatch; result: Settings };
  get_correction: { params: void; result: Correction };
  set_correction: { params: CorrectionPatch; result: Correction };
  start_logging: { params: StartLoggingParams; result: Empty };
  stop_logging: { params: void; result: Empty };
  set_name: { params: { name: string }; result: { name: string } };
  set_time: { params: { ts: number }; result: { ts: number } };
  get_probe_info: { params: void; result: ProbeInfo };
  get_count: { params: void; result: CountResult };
  clear_data: { params: void; result: Empty };
  calibrate_co2: { params: CalibrateCo2Params; result: Empty };
}

export type CommandName = keyof CommandMap;
export type ParamsOf<K extends CommandName> = CommandMap[K]['params'];
export type ResultOf<K extends CommandName> = CommandMap[K]['result'];

export interface CommandPolicy {
  timeoutMs: number;
  /** Safe to resend once after a timeout / firmware parse failure (idempotent). */
  retry: boolean;
}

/** Timeouts follow the official app (DeviceSetting.xaml.cs); retries only for idempotent commands. */
export const COMMAND_POLICY: Readonly<Record<CommandName, CommandPolicy>> = {
  hello: { timeoutMs: 3000, retry: true },
  get_battery: { timeoutMs: 5000, retry: true },
  get_settings: { timeoutMs: 5000, retry: true },
  set_settings: { timeoutMs: 5000, retry: true },
  get_correction: { timeoutMs: 5000, retry: true },
  set_correction: { timeoutMs: 5000, retry: true },
  start_logging: { timeoutMs: 5000, retry: false },
  stop_logging: { timeoutMs: 5000, retry: true },
  set_name: { timeoutMs: 15000, retry: false },
  set_time: { timeoutMs: 5000, retry: true },
  get_probe_info: { timeoutMs: 5000, retry: true },
  get_count: { timeoutMs: 10000, retry: true },
  clear_data: { timeoutMs: 10000, retry: false },
  calibrate_co2: { timeoutMs: 5000, retry: false },
};
