<script setup lang="ts">
/**
 * One quantity, every device overlaid (uPlot on canvas). Data is pulled from the devices'
 * in-memory series by the shared frame scheduler only when something changed and the chart is
 * on screen; long windows are decimated to ~1.5 points per pixel.
 */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { buildChartData } from '../../../core/data/decimate';
import type { SeriesChannel } from '../../../core/data/series';
import { registerDrawable, type Drawable } from '../../composables/useChartScheduler';
import { locale, t } from '../../i18n';
import { useDevicesStore, type DeviceEntry } from '../../stores/devices';
import { useSettingsStore } from '../../stores/settings';

export interface ChartWindow {
  /** Seconds back from the newest sample, or the whole in-memory history. */
  range: number | 'all';
  zoom: { t0: number; t1: number } | null;
}

const props = defineProps<{
  channel: SeriesChannel;
  title: string;
  unit: string;
  decimals: number;
  window: ChartWindow;
}>();
const emit = defineEmits<{ zoom: [t0: number, t1: number] }>();

const devices = useDevicesStore();
const settings = useSettingsStore();
const root = ref<HTMLElement>();
const plotEl = ref<HTMLElement>();
const empty = ref(true);
const HEIGHT = 180;

let u: uPlot | null = null;
let tip: HTMLDivElement | null = null;
/** Only the chart under the pointer shows a tooltip; synced charts show the crosshair only. */
let hovered = false;
let seriesKey = '';
let width = 0;
let colors: string[] = [];
let textColor = '#5f5f5f';
let fontFamily = 'system-ui, sans-serif';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const nameOf = (e: DeviceEntry) => e.state.value.meta.name ?? e.state.value.bleName ?? e.key;
const fmt = (v: number) => v.toFixed(props.decimals);

function windowFor(entries: readonly DeviceEntry[]): [number, number] {
  if (props.window.zoom) return [props.window.zoom.t0, props.window.zoom.t1];
  let first = Infinity;
  let last = -Infinity;
  for (const e of entries) {
    const s = e.controller.series;
    if (!s.length) continue;
    first = Math.min(first, s.firstTs);
    last = Math.max(last, s.lastTs);
  }
  if (!Number.isFinite(last)) {
    const now = Date.now() / 1000;
    return [now - (typeof props.window.range === 'number' ? props.window.range : 600), now];
  }
  if (props.window.range === 'all') return [first, Math.max(last, first + 60)];
  return [last - props.window.range, last];
}

function signature(entries: readonly DeviceEntry[]): string {
  let v = 0;
  for (const e of entries) v += e.controller.series.version;
  const w = props.window;
  return [
    entries.length,
    v,
    w.range,
    w.zoom?.t0,
    w.zoom?.t1,
    width,
    settings.conditionsVersion,
    settings.themeVersion,
    locale.value,
  ].join('|');
}

/** Short colour key + name at the right end of each line (≤ 4 devices, no collisions). */
function drawEndLabels(plot: uPlot): void {
  const entries = devices.entries;
  if (entries.length === 0 || entries.length > 4) return;
  const dpr = uPlot.pxRatio;
  const right = plot.bbox.left + plot.bbox.width;
  const labels: Array<{ y: number; name: string; color: string }> = [];
  for (let s = 1; s < plot.series.length; s++) {
    const ys = plot.data[s] as Array<number | null | undefined>;
    let j = ys.length - 1;
    while (j >= 0 && typeof ys[j] !== 'number') j--;
    if (j < 0) continue;
    // label lines that reach (close to) the right edge; slower channels end a little earlier
    if (plot.valToPos(plot.data[0][j]!, 'x', true) < right - Math.max(6 * dpr, plot.bbox.width * 0.05)) continue;
    const entry = entries[s - 1];
    if (!entry) continue;
    labels.push({ y: plot.valToPos(ys[j] as number, 'y', true), name: nameOf(entry), color: colors[s - 1] ?? textColor });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i]!.y - labels[i - 1]!.y < 14 * dpr) return;
  const ctx = plot.ctx;
  ctx.save();
  ctx.font = `${11 * dpr}px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const x0 = right + 6 * dpr;
  for (const l of labels) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x0, l.y);
    ctx.lineTo(x0 + 8 * dpr, l.y);
    ctx.stroke();
    ctx.fillStyle = textColor;
    const text = l.name.length > 14 ? `${l.name.slice(0, 13)}…` : l.name;
    ctx.fillText(text, x0 + 12 * dpr, l.y);
  }
  ctx.restore();
}

/** One tooltip, every device: value first, name second; nearest sample of each device. */
function updateTooltip(plot: uPlot): void {
  if (!tip) return;
  const idx = plot.cursor.idx;
  const left = plot.cursor.left ?? -1;
  if (!hovered || idx == null || left < 0) {
    tip.style.display = 'none';
    return;
  }
  const xs = plot.data[0];
  const x = xs[idx]!;
  const span = (plot.scales.x?.max ?? 0) - (plot.scales.x?.min ?? 0);
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip__time';
  head.textContent = new Date(x * 1000).toLocaleString(locale.value === 'ja' ? 'ja-JP' : 'en-GB', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  tip.appendChild(head);
  devices.entries.forEach((entry, i) => {
    const ys = plot.data[i + 1] as Array<number | null | undefined>;
    let best: number | null = null;
    let bestDist = Infinity;
    for (let d = 0; d < 80; d++) {
      for (const j of [idx - d, idx + d]) {
        if (j < 0 || j >= ys.length) continue;
        const v = ys[j];
        if (typeof v !== 'number') continue;
        const dist = Math.abs(xs[j]! - x);
        if (dist < bestDist) [best, bestDist] = [v, dist];
      }
      if (best !== null) break;
    }
    const row = document.createElement('div');
    row.className = 'tip__row';
    const key = document.createElement('span');
    key.className = 'tip__key';
    key.style.background = colors[i] ?? textColor;
    const val = document.createElement('span');
    val.className = 'tip__val';
    val.textContent = best !== null && bestDist <= span / 40 ? `${fmt(best)} ${props.unit}`.trim() : '—';
    const name = document.createElement('span');
    name.className = 'tip__name';
    name.textContent = nameOf(entry);
    row.append(key, val, name);
    tip!.appendChild(row);
  });
  tip.style.display = 'block';
  const overW = plot.over.clientWidth;
  const tipW = tip.offsetWidth;
  tip.style.left = `${left + 14 + tipW > overW ? left - tipW - 14 : left + 14}px`;
  tip.style.top = `4px`;
}

/** 24-hour tick labels; the date is added where the day changes (or for day-scale steps). */
function timeTicks(splits: number[], incr: number): string[] {
  const loc = locale.value === 'ja' ? 'ja-JP' : 'en-GB';
  const hm = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
  const hms = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const md = new Intl.DateTimeFormat(loc, { month: 'numeric', day: 'numeric' });
  return splits.map((v, i) => {
    const d = new Date(v * 1000);
    if (incr >= 86400) return md.format(d);
    const time = (incr < 60 ? hms : hm).format(d);
    const prev = i > 0 ? new Date(splits[i - 1]! * 1000) : null;
    return prev && prev.getDate() !== d.getDate() ? `${md.format(d)} ${time}` : time;
  });
}

function onSelect(plot: uPlot): void {
  const sel = plot.select;
  if (sel.width > 4) {
    emit('zoom', plot.posToVal(sel.left, 'x'), plot.posToVal(sel.left + sel.width, 'x'));
  }
  plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
}

function build(entries: readonly DeviceEntry[]): void {
  u?.destroy();
  u = null;
  if (!plotEl.value) return;
  const surface = css('--c-bg') || '#ffffff';
  const grid = css('--chart-grid') || '#ececea';
  const axis = css('--c-fg-subtle') || '#8c8c8c';
  textColor = css('--c-fg-muted') || '#5f5f5f';
  fontFamily = css('--font-sans') || 'system-ui, sans-serif';
  colors = entries.map((e) => css(`--series-${e.colorIndex + 1}`) || '#3774b5');
  const font = `11px ${fontFamily}`;
  const opts: uPlot.Options = {
    width: Math.max(200, width),
    height: HEIGHT,
    padding: [8, entries.length > 0 && entries.length <= 4 ? 110 : 12, 0, 0],
    legend: { show: false },
    cursor: {
      sync: { key: 'm-web-charts' },
      drag: { x: true, y: false, setScale: false },
      y: false,
      points: {
        size: 8,
        width: 2,
        stroke: () => surface,
        fill: (_p: uPlot, i: number) => colors[i - 1] ?? axis,
      },
    },
    scales: { x: { time: true } },
    axes: [
      {
        stroke: axis,
        font,
        grid: { stroke: grid, width: 1 },
        ticks: { show: false },
        size: 26,
        space: 90,
        values: (_p: uPlot, splits: number[], _ax: number, _space: number, incr: number) => timeTicks(splits, incr),
      },
      { stroke: axis, font, grid: { stroke: grid, width: 1 }, ticks: { show: false }, size: 46, space: 32 },
    ],
    series: [
      {},
      ...entries.map((_e, i) => ({ stroke: colors[i]!, width: 2, points: { show: false }, spanGaps: false })),
    ],
    hooks: { setSelect: [onSelect], draw: [drawEndLabels], setCursor: [updateTooltip] },
  };
  u = new uPlot(opts, [[], ...entries.map(() => [])] as uPlot.AlignedData, plotEl.value);
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.style.display = 'none';
  u.over.appendChild(tip);
  u.over.addEventListener('mouseenter', () => (hovered = true));
  u.over.addEventListener('mouseleave', () => {
    hovered = false;
    if (tip) tip.style.display = 'none';
  });
}

function draw(): void {
  const entries = devices.entries;
  const key = `${settings.themeVersion}|` + entries.map((e) => `${e.key}:${e.colorIndex}`).join(',');
  if (!u || key !== seriesKey) {
    seriesKey = key;
    build(entries);
  }
  if (!u) return;
  const [t0, t1] = windowFor(entries);
  const data = buildChartData(
    entries.map((e) => e.controller.series),
    props.channel,
    t0,
    t1,
    Math.max(120, Math.round(width * 1.5)),
  );
  empty.value = data.ys.every((y) => !y.some((v) => typeof v === 'number'));
  u.batch(() => {
    u!.setData([data.x, ...data.ys] as uPlot.AlignedData, true);
    u!.setScale('x', { min: t0, max: t1 });
  });
}

const drawable: Drawable = {
  visible: false,
  lastDraw: 0,
  drawnSig: '',
  signature: () => signature(devices.entries),
  draw,
  minIntervalMs: () => (props.window.zoom || props.window.range === 'all' || props.window.range > 3600 ? 1000 : 0),
};

let unregister: (() => void) | null = null;
let resizeObs: ResizeObserver | null = null;
let visObs: IntersectionObserver | null = null;

onMounted(() => {
  width = plotEl.value?.clientWidth ?? 600;
  resizeObs = new ResizeObserver((entries) => {
    const w = Math.round(entries[0]?.contentRect.width ?? width);
    if (w === width || w <= 0) return;
    width = w;
    u?.setSize({ width: Math.max(200, w), height: HEIGHT });
  });
  if (plotEl.value) resizeObs.observe(plotEl.value);
  visObs = new IntersectionObserver((entries) => {
    drawable.visible = entries.some((e) => e.isIntersecting);
  });
  if (root.value) visObs.observe(root.value);
  unregister = registerDrawable(drawable);
});

onBeforeUnmount(() => {
  unregister?.();
  resizeObs?.disconnect();
  visObs?.disconnect();
  u?.destroy();
  u = null;
});
</script>

<template>
  <figure ref="root" class="chart">
    <figcaption class="chart__title">
      {{ title }} <span class="chart__unit">{{ unit }}</span>
    </figcaption>
    <div ref="plotEl" class="chart__plot" :class="{ 'is-empty': empty }" />
    <p v-if="empty" class="chart__empty">{{ t('charts.noData') }}</p>
  </figure>
</template>

<style scoped>
.chart {
  position: relative;
  min-width: 0;
  margin: 0;
}
.chart__title {
  margin-bottom: var(--sp-1);
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
}
.chart__unit {
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
.chart__plot {
  width: 100%;
  min-height: 180px;
}
.chart__plot.is-empty {
  opacity: 0.35;
}
.chart__empty {
  position: absolute;
  inset: 40% 0 auto;
  text-align: center;
  color: var(--c-fg-subtle);
  font-size: var(--fs-s);
  pointer-events: none;
}
.chart__plot :deep(.u-select) {
  background: color-mix(in srgb, var(--c-fg) 7%, transparent);
}
.chart__plot :deep(.u-cursor-x) {
  border-right: 1px solid var(--c-line-strong);
}
.chart__plot :deep(.tip) {
  position: absolute;
  z-index: 5;
  min-width: 150px;
  padding: 8px 10px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--c-bg) 96%, transparent);
  box-shadow: 0 2px 10px rgb(0 0 0 / 6%);
  font-size: var(--fs-xs);
  line-height: 1.5;
  pointer-events: none;
}
.chart__plot :deep(.tip__time) {
  margin-bottom: 4px;
  color: var(--c-fg-subtle);
  font-variant-numeric: tabular-nums;
}
.chart__plot :deep(.tip__row) {
  display: flex;
  align-items: center;
  gap: 8px;
}
.chart__plot :deep(.tip__key) {
  width: 10px;
  height: 2px;
  border-radius: 1px;
  flex: none;
}
.chart__plot :deep(.tip__val) {
  min-width: 5.5em;
  color: var(--c-fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.chart__plot :deep(.tip__name) {
  color: var(--c-fg-muted);
}
</style>
