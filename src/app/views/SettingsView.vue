<script setup lang="ts">
import { computed } from 'vue';
import { downloadBlob } from '../export';
import { locale, setLocale, t, type Locale, type MessageKey } from '../i18n';
import { useDevicesStore } from '../stores/devices';
import { useSettingsStore, type Theme } from '../stores/settings';

const settings = useSettingsStore();
const devices = useDevicesStore();
const version = __APP_VERSION__;
const THEMES: Theme[] = ['system', 'light', 'dark'];

const assumeOn = computed({
  get: () => settings.conditions.assumedAirSpeed !== null,
  set: (on: boolean) => settings.setConditions({ assumedAirSpeed: on ? 0.1 : null }),
});
const assumedSpeed = computed({
  get: () => settings.conditions.assumedAirSpeed ?? 0.1,
  set: (v: number) =>
    Number.isFinite(v) && settings.setConditions({ assumedAirSpeed: Math.min(1.5, Math.max(0, Math.round(v * 100) / 100)) }),
});
const relative = computed({
  get: () => settings.conditions.relativeSpeed,
  set: (v: boolean) => settings.setConditions({ relativeSpeed: v }),
});

function saveLog() {
  const parts: string[] = [`m-web ${version} traffic log — ${new Date().toISOString()}\n`];
  for (const e of devices.entries) {
    const s = e.state.value;
    parts.push(`\n## ${s.meta.name ?? s.bleName ?? e.key} (${s.meta.hardwareId ?? '?'}, fw ${s.meta.firmware ?? '?'})\n`);
    parts.push(e.traffic.join('\n') + '\n');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(new Blob(parts, { type: 'text/plain;charset=utf-8' }), `m-web-log-${stamp}.txt`);
}
</script>

<template>
  <section class="page settings">
    <h1 class="title">{{ t('settings.title') }}</h1>

    <section class="block">
      <h2>{{ t('settings.display') }}</h2>
      <div class="field">
        <span class="label">{{ t('settings.language') }}</span>
        <label v-for="l in ['ja', 'en'] as Locale[]" :key="l">
          <input type="radio" name="lang" :checked="locale === l" @change="setLocale(l)" />
          {{ t(`lang.${l}` as MessageKey) }}
        </label>
      </div>
      <div class="field">
        <span class="label">{{ t('settings.theme') }}</span>
        <label v-for="th in THEMES" :key="th">
          <input v-model="settings.theme" type="radio" name="theme" :value="th" />
          {{ t(`settings.themes.${th}` as MessageKey) }}
        </label>
      </div>
    </section>

    <section class="block">
      <h2>{{ t('settings.comfort') }}</h2>
      <div class="field">
        <label>
          <input v-model="assumeOn" type="checkbox" />
          {{ t('settings.assumedSpeed') }}
        </label>
        <input v-model.number="assumedSpeed" class="num" type="number" min="0" max="1.5" step="0.05" :disabled="!assumeOn" />
        <span class="unit">m/s</span>
      </div>
      <p class="hint">{{ t('settings.assumedSpeedHint') }}</p>
      <div class="field">
        <label><input v-model="relative" type="checkbox" /> {{ t('settings.relativeSpeed') }}</label>
      </div>
      <p class="hint">{{ t('settings.relativeSpeedHint') }}</p>
    </section>

    <section class="block">
      <h2>{{ t('settings.diagnostics') }}</h2>
      <p class="hint">{{ t('settings.diagnosticsHint') }}</p>
      <button class="btn btn--small" :disabled="devices.entries.length === 0" @click="saveLog">
        {{ t('settings.downloadLog') }}
      </button>
    </section>

    <section class="block">
      <h2>{{ t('settings.about') }}</h2>
      <p>{{ t('settings.version', { v: version }) }}</p>
      <p class="hint">{{ t('settings.license') }}</p>
      <p class="hint">
        <a href="https://github.com/et0614/mlogger" target="_blank" rel="noopener">et0614/mlogger</a> ·
        <a href="https://www.mlogger.jp/" target="_blank" rel="noopener">mlogger.jp</a>
      </p>
    </section>
  </section>
</template>

<style scoped>
.settings {
  max-width: 820px;
}
.title {
  margin-bottom: var(--sp-6);
  font-size: var(--fs-xl);
}
.block {
  padding: var(--sp-5) 0;
  border-top: 1px solid var(--c-line);
}
.block h2 {
  margin-bottom: var(--sp-3);
  font-size: var(--fs-m);
  font-weight: 600;
}
.field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2) var(--sp-4);
  margin-bottom: var(--sp-2);
}
.field label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.label {
  min-width: 7em;
  color: var(--c-fg-muted);
}
input[type='number'] {
  width: 5em;
  padding: 3px 6px;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--radius-s);
  background: var(--c-bg);
  text-align: right;
}
.unit {
  color: var(--c-fg-subtle);
}
.hint {
  margin-bottom: var(--sp-3);
  color: var(--c-fg-subtle);
  font-size: var(--fs-s);
}
</style>
