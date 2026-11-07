<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatVoltage } from '../../format';
import { t } from '../../i18n';
import type { DeviceEntry } from '../../stores/devices';

const props = defineProps<{ entry: DeviceEntry; online: boolean }>();
const s = computed(() => props.entry.state.value);
const busy = ref(false);

async function refreshBattery() {
  busy.value = true;
  try {
    await props.entry.controller.refreshBattery();
  } finally {
    busy.value = false;
  }
}

const stats = computed(() => {
  void s.value; // re-evaluate with state changes
  const link = props.entry.controller.linkStats;
  const rtt = props.entry.controller.protocolClient?.stats.lastRttMs ?? 0;
  return link ? t('drawer.linkStats', { unlock: Math.round(link.unlockMs), rtt: Math.round(rtt) }) : '—';
});
</script>

<template>
  <section class="sec">
    <h3 class="sec__title">{{ t('drawer.overview') }}</h3>
    <dl class="kv">
      <dt>{{ t('drawer.hardwareId') }}</dt>
      <dd class="mono">{{ s.meta.hardwareId ?? '—' }}</dd>
      <dt>{{ t('drawer.firmware') }}</dt>
      <dd>{{ s.meta.firmware ?? '—' }}</dd>
      <dt>{{ t('drawer.bleName') }}</dt>
      <dd>{{ s.bleName ?? '—' }}</dd>
      <dt>{{ t('drawer.battery') }}</dt>
      <dd>
        <span class="num" :class="{ warn: s.meta.battery?.low_battery }">{{ formatVoltage(s.meta.battery?.voltage_mv) }}</span>
        <span v-if="s.meta.battery?.low_battery" class="warn"> · {{ t('device.lowBattery') }}</span>
        <button class="btn btn--small btn--quiet" :disabled="!online || busy" @click="refreshBattery">
          {{ t('drawer.refresh') }}
        </button>
      </dd>
      <dt>{{ t('drawer.probes') }}</dt>
      <dd>
        <div>
          {{ t('drawer.thProbe') }}:
          {{ s.meta.probes ? (s.meta.probes.th_probe.connected ? t('drawer.probeConnected') : t('drawer.probeMissing')) : '—' }}
        </div>
        <div>
          {{ t('drawer.velocityProbe') }}:
          {{
            s.meta.probes ? (s.meta.probes.velocity_probe.connected ? t('drawer.probeConnected') : t('drawer.probeMissing')) : '—'
          }}
        </div>
      </dd>
      <dt>{{ t('drawer.link') }}</dt>
      <dd class="muted">{{ stats }}</dd>
    </dl>
  </section>
</template>

<style scoped src="./drawer.css"></style>
