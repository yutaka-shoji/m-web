/** M-Logger v4 JSON protocol types (docs/protocol_v4.md in et0614/mlogger, firmware 4.0.x). */

export interface HelloResult {
  device: string;
  firmware_version: string;
  protocol_version: number;
  hardware_id: string;
  name: string;
  logging: boolean;
}

export interface BatteryResult {
  voltage_mv: number;
  low_battery: boolean;
}

/** Measurement settings are grouped per probe: general = t_dry + humidity + t_glb + co2. */
export type CategoryKey = 'general' | 'velocity' | 'illuminance';
export const CATEGORY_KEYS: readonly CategoryKey[] = ['general', 'velocity', 'illuminance'];

export interface CategorySetting {
  enabled: boolean;
  /** Seconds, 1..99999 (firmware). */
  interval: number;
}

export interface Settings {
  general: CategorySetting;
  velocity: CategorySetting;
  illuminance: CategorySetting;
  /** Unix seconds; 0 = start immediately. */
  start_ts: number;
}

export interface SettingsPatch {
  general?: Partial<CategorySetting>;
  velocity?: Partial<CategorySetting>;
  illuminance?: Partial<CategorySetting>;
  start_ts?: number;
}

export type CorrectionKey = 't_dry' | 'humidity' | 't_glb' | 'illuminance' | 'velocity';
export const CORRECTION_KEYS: readonly CorrectionKey[] = ['t_dry', 'humidity', 't_glb', 'illuminance', 'velocity'];

export interface LinearCorrection {
  a: number;
  b: number;
}

export type Correction = Record<CorrectionKey, LinearCorrection>;
export type CorrectionPatch = Partial<Record<CorrectionKey, Partial<LinearCorrection>>>;

export interface Transports {
  zigbee: boolean;
  ble: boolean;
  flash: boolean;
  usb: boolean;
}

export interface StartLoggingParams {
  transports: Transports;
  mode: 'once' | 'auto_restart';
}

export interface ProbeStatus {
  connected: boolean;
  device_id?: string;
  name?: string;
  data_count?: number;
}

export interface ProbeInfo {
  th_probe: ProbeStatus;
  velocity_probe: ProbeStatus;
}

export interface CountResult {
  count: number;
  record_size: number;
  format: string;
}

export interface DumpHeader {
  count: number;
  from: number;
  record_size: number;
  format: string;
}

export type CalibrateCo2Params = { mode: 'forced' | 'factory'; target_ppm: number } | { mode: 'reset' };

// ------------------------------------------------------------------ events

/** Category ids used by `wu` (warming up) / `dc` (disconnected) in smp events. */
export type SensorCategoryId = 'g' | 'v' | 'l';

/** smp payload with short keys. Absent = not measured this tick; null = measured but invalid. */
export interface SmpData {
  t?: number | null;
  h?: number | null;
  g?: number | null;
  v?: number | null;
  vv?: number | null;
  l?: number | null;
  c?: number | null;
  wu?: SensorCategoryId[];
  dc?: SensorCategoryId[];
}

export interface SmpEvent {
  /** Device timestamp (unix s, UTC). */
  ts: number;
  data: SmpData;
  /** PC time of arrival (ms). */
  receivedAt: number;
}

export interface ReadyEvent {
  ts: number;
  uptime_s?: number;
  logging?: boolean;
  name?: string;
  receivedAt: number;
}

export interface Co2CalibrationProgress {
  ts: number;
  remaining_s: number;
  state: 'measuring' | 'pass' | 'fail';
  correction_ppm: number;
  current_ppm: number;
}

export interface TimeSyncRequest {
  ts: number;
  window_s: number;
  name?: string;
  receivedAt: number;
}

export interface DumpEnd {
  ts: number;
  sent: number;
}
