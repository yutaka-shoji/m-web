<script setup lang="ts">
import { computed } from 'vue';
import { t, type MessageKey } from '../../i18n';
import { CLO_PRESETS, MET_PRESETS, useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

const clo = computed({
  get: () => settings.conditions.clo,
  set: (v: number) => Number.isFinite(v) && settings.setConditions({ clo: clamp(Math.round(v * 100) / 100, 0, 3) }),
});
const met = computed({
  get: () => settings.conditions.met,
  set: (v: number) => Number.isFinite(v) && settings.setConditions({ met: clamp(Math.round(v * 100) / 100, 0.5, 8) }),
});

const cloPreset = computed(() => CLO_PRESETS.find((p) => p.value === clo.value)?.value ?? '');
const metPreset = computed(() => MET_PRESETS.find((p) => p.value === met.value)?.value ?? '');
</script>

<template>
  <section class="cond" :aria-label="t('comfort.conditions')">
    <h2 class="cond__title">{{ t('comfort.conditions') }}</h2>
    <div class="field">
      <label for="clo">{{ t('comfort.clo') }}</label>
      <input id="clo" v-model.number="clo" class="num" type="number" min="0" max="3" step="0.1" />
      <span class="unit">clo</span>
      <select
        :aria-label="`${t('comfort.clo')} — ${t('comfort.preset')}`"
        :value="cloPreset"
        @change="clo = Number(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>{{ t('comfort.preset') }}</option>
        <option v-for="p in CLO_PRESETS" :key="p.key" :value="p.value">
          {{ t(`comfort.cloPresets.${p.key}` as MessageKey) }}（{{ p.value.toFixed(1) }}）
        </option>
      </select>
    </div>
    <div class="field">
      <label for="met">{{ t('comfort.met') }}</label>
      <input id="met" v-model.number="met" class="num" type="number" min="0.5" max="8" step="0.1" />
      <span class="unit">met</span>
      <select
        :aria-label="`${t('comfort.met')} — ${t('comfort.preset')}`"
        :value="metPreset"
        @change="met = Number(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>{{ t('comfort.preset') }}</option>
        <option v-for="p in MET_PRESETS" :key="p.key" :value="p.value">
          {{ t(`comfort.metPresets.${p.key}` as MessageKey) }}（{{ p.value.toFixed(1) }}）
        </option>
      </select>
    </div>
    <p class="cond__hint">{{ t('comfort.hint') }}</p>
  </section>
</template>

<style scoped>
.cond {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2) var(--sp-5);
}
.cond__title {
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
  font-weight: 500;
}
.field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-s);
}
.field label {
  color: var(--c-fg-muted);
}
input[type='number'] {
  width: 4.2em;
  padding: 3px 6px;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--radius-s);
  background: var(--c-bg);
  text-align: right;
}
select {
  max-width: 13em;
  padding: 3px 4px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-s);
  background: var(--c-bg);
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
}
.unit {
  color: var(--c-fg-subtle);
}
.cond__hint {
  flex-basis: 100%;
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
</style>
