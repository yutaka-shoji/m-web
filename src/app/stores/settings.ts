import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { DEFAULT_CONDITIONS, type ComfortConditions } from '../../core/comfort/comfort';

const KEY = 'm-web.conditions';

/** Typical values (ASHRAE 55 / ISO 7730 tables). */
export const CLO_PRESETS = [
  { value: 0.5, key: 'summer' },
  { value: 0.7, key: 'longSleeve' },
  { value: 1.0, key: 'winter' },
  { value: 1.3, key: 'heavy' },
] as const;

export const MET_PRESETS = [
  { value: 1.0, key: 'seated' },
  { value: 1.1, key: 'typing' },
  { value: 1.2, key: 'office' },
  { value: 1.6, key: 'standing' },
  { value: 2.0, key: 'walking' },
] as const;

function load(): ComfortConditions {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<ComfortConditions>;
      return {
        clo: typeof v.clo === 'number' ? v.clo : DEFAULT_CONDITIONS.clo,
        met: typeof v.met === 'number' ? v.met : DEFAULT_CONDITIONS.met,
        relativeSpeed: v.relativeSpeed === true,
        assumedAirSpeed: typeof v.assumedAirSpeed === 'number' ? v.assumedAirSpeed : null,
      };
    }
  } catch {
    // ignore unavailable/corrupt storage
  }
  return { ...DEFAULT_CONDITIONS };
}

export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'm-web.theme';

function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {
    // ignore
  }
  return 'system';
}

export const useSettingsStore = defineStore('settings', () => {
  const conditions = ref<ComfortConditions>(load());
  const theme = ref<Theme>(loadTheme());
  /** Increments when the effective colours change (charts re-read their CSS colours). */
  const themeVersion = ref(0);

  function applyTheme(t: Theme): void {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    if (t === 'system') delete el.dataset.theme;
    else el.dataset.theme = t;
    themeVersion.value += 1;
  }
  watch(
    theme,
    (t) => {
      applyTheme(t);
      try {
        localStorage.setItem(THEME_KEY, t);
      } catch {
        // ignore
      }
    },
    { immediate: true },
  );
  if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (themeVersion.value += 1));
  }
  /** Increments whenever the comfort conditions change (derived values must be recomputed). */
  const conditionsVersion = ref(0);

  watch(
    conditions,
    (c) => {
      conditionsVersion.value += 1;
      try {
        localStorage.setItem(KEY, JSON.stringify(c));
      } catch {
        // ignore
      }
    },
    { deep: true },
  );

  function setConditions(patch: Partial<ComfortConditions>): void {
    conditions.value = { ...conditions.value, ...patch };
  }

  return { conditions, conditionsVersion, setConditions, theme, themeVersion };
});
