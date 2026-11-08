<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SeriesChannel } from '../../../core/data/series';
import { UNITS } from '../../../core/device/quantities';
import { t, type MessageKey } from '../../i18n';
import { useDevicesStore } from '../../stores/devices';
import QuantityChart, { type ChartWindow } from './QuantityChart.vue';

const devices = useDevicesStore();

const RANGES = [
  { key: 'm10', seconds: 600 },
  { key: 'h1', seconds: 3600 },
  { key: 'h6', seconds: 6 * 3600 },
  { key: 'h24', seconds: 24 * 3600 },
  { key: 'all', seconds: 'all' as const },
] as const;

const range = ref<number | 'all'>(600);
const zoom = ref<{ t0: number; t1: number } | null>(null);
const win = computed<ChartWindow>(() => ({ range: range.value, zoom: zoom.value }));

const CHARTS: Array<{ ch: SeriesChannel; title: MessageKey; unit: string; decimals: number }> = [
  { ch: 't', title: 'q.t', unit: UNITS.t, decimals: 1 },
  { ch: 'h', title: 'q.h', unit: UNITS.h, decimals: 0 },
  { ch: 'g', title: 'q.g', unit: UNITS.g, decimals: 1 },
  { ch: 'mrt', title: 'comfort.mrtLong', unit: '°C', decimals: 1 },
  { ch: 'v', title: 'q.v', unit: UNITS.v, decimals: 2 },
  { ch: 'pmv', title: 'comfort.pmvLong', unit: '', decimals: 2 },
  { ch: 'l', title: 'q.l', unit: UNITS.l, decimals: 0 },
  { ch: 'c', title: 'q.c', unit: UNITS.c, decimals: 0 },
];

function setRange(seconds: number | 'all') {
  range.value = seconds;
  zoom.value = null;
}
</script>

<template>
  <section class="stack" :aria-label="t('charts.title')">
    <header class="stack__head">
      <h2 class="stack__title">{{ t('charts.title') }}</h2>
      <div class="seg" role="group" :aria-label="t('charts.range')">
        <button
          v-for="r in RANGES"
          :key="r.key"
          type="button"
          class="seg__btn"
          :data-range="r.key"
          :class="{ 'is-active': !zoom && range === r.seconds }"
          :aria-pressed="!zoom && range === r.seconds"
          @click="setRange(r.seconds)"
        >
          {{ t(`charts.ranges.${r.key}` as MessageKey) }}
        </button>
      </div>
      <button v-if="zoom" type="button" class="btn btn--small" @click="zoom = null">{{ t('charts.backToLive') }}</button>
      <ul class="legend" :aria-label="t('charts.legend')">
        <li v-for="e in devices.entries" :key="e.key" class="legend__item">
          <span class="legend__key" :style="{ background: `var(--series-${e.colorIndex + 1})` }" aria-hidden="true" />
          {{ e.state.value.meta.name ?? e.state.value.bleName ?? e.key }}
        </li>
      </ul>
    </header>
    <div class="stack__grid">
      <QuantityChart
        v-for="c in CHARTS"
        :key="c.ch"
        :channel="c.ch"
        :title="t(c.title)"
        :unit="c.unit"
        :decimals="c.decimals"
        :window="win"
        @zoom="(t0, t1) => (zoom = { t0, t1 })"
      />
    </div>
    <p class="stack__hint">{{ t('charts.zoomHint') }}</p>
  </section>
</template>

<style scoped>
.stack {
  margin-top: var(--sp-7);
  scroll-margin-top: calc(var(--header-h) + var(--sp-4));
}
.stack__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3) var(--sp-5);
  margin-bottom: var(--sp-5);
}
.stack__title {
  font-size: var(--fs-l);
  font-weight: 600;
}
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius);
  background: var(--c-fill);
}
.seg__btn {
  padding: 4px 10px;
  border: 0;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
  cursor: pointer;
}
.seg__btn.is-active {
  background: var(--c-bg);
  color: var(--c-fg);
  box-shadow: 0 0 0 1px var(--c-line);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-4);
  margin: 0 0 0 auto;
  padding: 0;
  list-style: none;
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
}
.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend__key {
  width: 14px;
  height: 2px;
  border-radius: 1px;
}
.stack__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr));
  gap: var(--sp-6) var(--sp-6);
}
.stack__hint {
  margin-top: var(--sp-4);
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
</style>
