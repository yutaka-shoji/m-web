<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Quantity } from '../../../core/device/quantities';
import { UNITS } from '../../../core/device/quantities';
import { useNow } from '../../composables/useNow';
import { formatAgo, formatValue, formatVoltage } from '../../format';
import { t, type MessageKey } from '../../i18n';
import type { DeviceEntry } from '../../stores/devices';
import { useDevicesStore } from '../../stores/devices';
import { useSettingsStore } from '../../stores/settings';
import { computeComfort } from '../../../core/comfort/comfort';
import StatusChip from '../ui/StatusChip.vue';

const props = defineProps<{ entry: DeviceEntry }>();
const route = useRoute();
const router = useRouter();
const openDetails = () => router.push({ query: { ...route.query, device: props.entry.key } });
const store = useDevicesStore();
const settings = useSettingsStore();
const now = useNow();
const s = computed(() => props.entry.state.value);
const live = computed(() => props.entry.live.value);
const busy = ref(false);
const error = ref<string | null>(null);

const SHOWN: readonly Quantity[] = ['t', 'h', 'g', 'v', 'l', 'c'];

const name = computed(() => s.value.meta.name ?? s.value.bleName ?? '—');

/** The browser lost track of the device: it reconnects only after a scan has seen it again. */
const lost = computed(() => {
  const c = s.value.conn;
  return c.notInRange && (c.state === 'reconnecting' || c.state === 'connecting' || c.state === 'failed');
});

const status = computed(() => {
  const st = s.value;
  const c = st.conn;
  if (lost.value) return { label: t('device.status.notInRange'), tone: 'warn' as const };
  switch (c.state) {
    case 'idle':
      return { label: t('device.status.idle'), tone: 'muted' as const };
    case 'connecting':
      return { label: t('device.status.connecting'), tone: 'muted' as const, pulse: true };
    case 'handshaking':
      return { label: t('device.status.handshaking'), tone: 'muted' as const, pulse: true };
    case 'reconnecting': {
      const secs = c.nextRetryAt ? Math.max(0, Math.ceil((c.nextRetryAt - now.value) / 1000)) : 0;
      return {
        label: t('device.status.reconnecting'),
        tone: 'warn' as const,
        pulse: secs === 0,
        detail: secs > 0 ? t('device.retryIn', { s: secs }) : t('device.reconnectAttempt', { n: c.attempt }),
      };
    }
    case 'failed':
      return { label: t('device.status.failed'), tone: 'warn' as const };
    case 'incompatible':
      return {
        label: c.incompatible === 'v3' ? t('device.status.v3') : t('device.status.notMlogger'),
        tone: 'warn' as const,
      };
    case 'online':
    default:
      if (!st.logging) return { label: t('device.status.standby'), tone: 'muted' as const };
      if (st.stream === 'flowing') return { label: t('device.status.live'), tone: 'accent' as const, pulse: true };
      if (st.stream === 'scheduled') return { label: t('device.status.scheduled'), tone: 'muted' as const };
      if (st.stream === 'silent') return { label: t('device.status.deviceOnly'), tone: 'muted' as const };
      return { label: t('device.status.starting'), tone: 'muted' as const, pulse: true };
  }
});

const shortestInterval = computed(() => {
  const st = s.value.meta.settings;
  if (!st) return 60;
  const iv = (['general', 'velocity', 'illuminance'] as const).filter((k) => st[k].enabled).map((k) => st[k].interval);
  return iv.length ? Math.min(...iv) : 60;
});

/** Values are shown dimmed when they are not being refreshed. */
const stale = computed(() => {
  const st = s.value;
  if (st.conn.state !== 'online' || !st.logging) return live.value.lastReceivedAt > 0;
  const last = live.value.lastReceivedAt;
  return last > 0 && now.value - last > Math.max(3 * shortestInterval.value, 15) * 1000;
});

const cells = computed(() =>
  SHOWN.map((q) => {
    const v = live.value.values[q];
    return {
      q,
      label: t(`q.${q}` as MessageKey),
      value: formatValue(q, v.value),
      unit: UNITS[q],
      reason: v.value === null ? t(`device.reason.${v.status}` as MessageKey) : '',
    };
  }),
);

const comfort = computed(() => computeComfort(live.value, settings.conditions));
const comfortNote = computed(() => {
  const c = comfort.value;
  if (c.status !== 'ok') return t(`comfort.status.${c.status}` as MessageKey);
  return c.assumedSpeed ? t('comfort.assumedSpeed') : '';
});
const rangeDetail = computed(() =>
  comfort.value.issues.length
    ? t('comfort.outOfRangeDetail', {
        items: comfort.value.issues.map((i) => t(`comfort.issues.${i}` as MessageKey)).join(', '),
      })
    : '',
);
const fmtC = (v: number | null, d: number) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(d));

const battery = computed(() => s.value.meta.battery);

async function run(action: () => Promise<unknown>) {
  busy.value = true;
  error.value = null;
  try {
    await action();
  } catch (e) {
    error.value = t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}

const ctrl = props.entry.controller;
const startLive = () => run(() => ctrl.startLive());
const stop = () => run(() => ctrl.stopLogging());
const addBle = () => run(() => ctrl.startLogging({ zigbee: false, ble: true, flash: true, usb: false }));
const find = () => run(() => store.findLostDevices());
const reconnect = () => (lost.value ? find() : void ctrl.connect());
const disconnect = () => ctrl.disconnect();
const remove = () => store.remove(props.entry.key);
</script>

<template>
  <article class="card" :aria-label="name">
    <header class="card__head">
      <span class="card__dot" :style="{ background: `var(--series-${entry.colorIndex + 1})` }" aria-hidden="true" />
      <div class="card__title">
        <h3 class="card__name">{{ name }}</h3>
        <p class="card__sub">
          <span v-if="s.meta.hardwareId" class="mono">{{ s.meta.hardwareId }}</span>
          <span v-if="s.meta.firmware">fw {{ s.meta.firmware }}</span>
          <span v-if="s.demo" class="card__badge">{{ t('device.demo') }}</span>
        </p>
      </div>
      <StatusChip v-bind="status" />
    </header>

    <p v-if="s.conn.state === 'incompatible' && s.conn.incompatible === 'v3'" class="card__note card__note--warn">
      {{ t('device.v3Message') }}
    </p>
    <p v-else-if="lost" class="card__note card__note--warn">
      {{ store.autoFind ? t('device.notInRangeAuto') : t('device.notInRangeHint') }}
    </p>
    <p v-else-if="s.stream === 'silent' && s.logging" class="card__note">{{ t('device.deviceOnlyHint') }}</p>

    <dl class="values" :class="{ 'is-stale': stale }" :title="stale ? t('device.stale') : undefined">
      <div v-for="c in cells" :key="c.q" class="value">
        <dt class="value__label">{{ c.label }}</dt>
        <dd class="value__body">
          <span class="value__num num">{{ c.value }}</span>
          <span class="value__unit">{{ c.unit }}</span>
        </dd>
        <dd v-if="c.reason" class="value__reason">{{ c.reason }}</dd>
      </div>
    </dl>

    <div class="comfort" :class="{ 'is-stale': stale }">
      <div class="comfort__cell" :title="t('comfort.mrtLong')">
        <span class="comfort__label">{{ t('comfort.mrt') }}</span>
        <span class="comfort__num num">{{ fmtC(comfort.mrt, 1) }}</span>
        <span class="value__unit">°C</span>
      </div>
      <div class="comfort__cell" :title="t('comfort.pmvLong')">
        <span class="comfort__label">{{ t('comfort.pmv') }}</span>
        <span class="comfort__num num">{{ fmtC(comfort.pmv, 2) }}</span>
      </div>
      <div class="comfort__cell" :title="t('comfort.ppdLong')">
        <span class="comfort__label">{{ t('comfort.ppd') }}</span>
        <span class="comfort__num num">{{ fmtC(comfort.ppd, 1) }}</span>
        <span class="value__unit">%</span>
      </div>
      <p v-if="comfortNote || rangeDetail" class="comfort__note">
        <span v-if="rangeDetail" class="comfort__range" :title="rangeDetail">{{ t('comfort.outOfRange') }}</span>
        <span v-if="comfortNote">{{ comfortNote }}</span>
      </p>
    </div>

    <footer class="card__foot">
      <div class="meta">
        <span v-if="battery" :class="{ warn: battery.low_battery }">
          {{ t('device.battery') }} <span class="num">{{ formatVoltage(battery.voltage_mv) }}</span>
          <template v-if="battery.low_battery"> · {{ t('device.lowBattery') }}</template>
        </span>
        <span v-if="live.lastReceivedAt">{{ t('device.lastUpdate') }} {{ formatAgo(live.lastReceivedAt, now) }}</span>
      </div>
      <div class="actions">
        <template v-if="s.conn.state === 'online'">
          <button v-if="!s.logging" class="btn btn--small" :disabled="busy" @click="startLive">
            {{ t('device.actions.live') }}
          </button>
          <button v-else-if="s.stream === 'silent'" class="btn btn--small" :disabled="busy" @click="addBle">
            {{ t('device.actions.live') }}
          </button>
          <button v-if="s.logging" class="btn btn--small" :disabled="busy" @click="stop">
            {{ t('device.actions.stop') }}
          </button>
          <button class="btn btn--small btn--quiet" @click="disconnect">{{ t('device.actions.disconnect') }}</button>
        </template>
        <template v-else-if="s.conn.state === 'reconnecting' || (lost && s.conn.state === 'connecting')">
          <button v-if="lost" class="btn btn--small" data-testid="find-device" :disabled="busy" @click="find">
            {{ t('device.actions.find') }}
          </button>
          <button class="btn btn--small btn--quiet" @click="disconnect">{{ t('device.actions.disconnect') }}</button>
        </template>
        <template v-else-if="s.conn.state === 'connecting' || s.conn.state === 'handshaking'">
          <button class="btn btn--small btn--quiet" @click="disconnect">{{ t('device.actions.cancel') }}</button>
        </template>
        <template v-else>
          <button class="btn btn--small" :disabled="busy" @click="reconnect">
            {{ lost ? t('device.actions.find') : t('device.actions.reconnect') }}
          </button>
          <button class="btn btn--small btn--quiet" @click="remove">{{ t('device.actions.remove') }}</button>
        </template>
        <button class="btn btn--small btn--quiet" data-testid="device-details" @click="openDetails">
          {{ t('device.actions.details') }}
        </button>
        <button
          v-if="entry.simulateDrop && s.conn.state === 'online'"
          class="btn btn--small btn--quiet"
          @click="entry.simulateDrop()"
        >
          {{ t('device.actions.simulateDrop') }}
        </button>
      </div>
    </footer>
    <p v-if="error" class="card__error" role="alert">{{ error }}</p>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-5) var(--sp-5) var(--sp-4);
  border: 1px solid var(--c-line);
  border-radius: var(--radius);
  background: var(--c-bg);
  min-width: 0;
}
.card__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}
.card__dot {
  width: 10px;
  height: 10px;
  margin-top: 7px;
  border-radius: 50%;
  flex: none;
}
.card__title {
  flex: 1;
  min-width: 0;
}
.card__name {
  font-size: var(--fs-l);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card__sub {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: 2px;
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
.mono {
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
}
.card__badge {
  padding: 0 6px;
  border: 1px solid var(--c-line-strong);
  border-radius: 999px;
  color: var(--c-fg-muted);
}
.card__note {
  margin-top: calc(-1 * var(--sp-2));
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
}
.card__note--warn {
  color: var(--c-warn);
}
.values {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-5) var(--sp-4);
  margin: 0;
  transition: opacity 200ms var(--ease);
}
.values.is-stale {
  opacity: 0.45;
}
.value {
  min-width: 0;
}
.value__label {
  color: var(--c-fg-muted);
  font-size: var(--fs-xs);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.value__body {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin: 2px 0 0;
}
.value__num {
  font-size: var(--fs-num);
  font-weight: 350;
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.value__unit {
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
.value__reason {
  margin: 2px 0 0;
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
.comfort {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2) var(--sp-4);
  margin-top: calc(-1 * var(--sp-2));
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--c-line);
  transition: opacity 200ms var(--ease);
}
.comfort.is-stale {
  opacity: 0.45;
}
.comfort__cell {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.comfort__label {
  color: var(--c-fg-muted);
  font-size: var(--fs-xs);
  letter-spacing: 0.04em;
}
.comfort__num {
  font-size: var(--fs-l);
  font-weight: 450;
}
.comfort__note {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
.comfort__range {
  color: var(--c-warn);
  cursor: help;
}
.card__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2) var(--sp-4);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--c-line);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-4);
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
.meta .warn {
  color: var(--c-warn);
}
.actions {
  display: flex;
  gap: var(--sp-1);
  margin-left: auto;
}
.card__error {
  margin-top: calc(-1 * var(--sp-3));
  color: var(--c-warn);
  font-size: var(--fs-s);
}
</style>
