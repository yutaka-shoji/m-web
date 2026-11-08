import { ref, watchEffect } from 'vue';
import { ja } from './ja';
import { en } from './en';
import type { Locale, MessageKey, Messages } from './types';

export type { Locale, MessageKey } from './types';

const STORAGE_KEY = 'm-web.locale';

function flatten(tree: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else flatten(v, key, out);
  }
  return out;
}

const dictionaries: Record<Locale, Map<string, string>> = {
  ja: flatten(ja satisfies Messages),
  en: flatten(en),
};

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    // storage may be unavailable (private mode); fall through
  }
  const langs = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  return langs.some((l) => l?.toLowerCase().startsWith('ja')) ? 'ja' : 'en';
}

export const locale = ref<Locale>(detectLocale());

watchEffect(() => {
  if (typeof document !== 'undefined') document.documentElement.lang = locale.value;
});

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
}

/** Translate `key`, replacing `{name}` placeholders with `params.name`. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const s = dictionaries[locale.value].get(key) ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
