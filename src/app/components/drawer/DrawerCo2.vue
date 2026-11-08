<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { Co2CalibrationProgress } from '../../../core/protocol/types';
import { t, type MessageKey } from '../../i18n';
import type { DeviceEntry } from '../../stores/devices';
import ConfirmDialog from '../ui/ConfirmDialog.vue';

const props = defineProps<{ entry: DeviceEntry; online: boolean }>();
const s = computed(() => props.entry.state.value);
const mode = ref<'forced' | 'factory' | 'reset'>('forced');
const target = ref(420);
const confirm = ref(false);
const progress = ref<Co2CalibrationProgress | null>(null);
const msg = ref<{ ok: boolean; text: string } | null>(null);
const unsub = props.entry.controller.onCo2((p) => {
  progress.value = p;
  if (p.state === 'pass') msg.value = { ok: true, text: t('drawer.co2Pass', { ppm: p.correction_ppm }) };
  if (p.state === 'fail') msg.value = { ok: false, text: t('drawer.co2Fail') };
});
onBeforeUnmount(unsub);

const validTarget = computed(() => mode.value === 'reset' || (target.value >= 300 && target.value <= 5000));
const running = computed(() => s.value.op === 'co2cal');

async function start() {
  confirm.value = false;
  msg.value = null;
  progress.value = null;
  try {
    const params = mode.value === 'reset' ? { mode: 'reset' as const } : { mode: mode.value, target_ppm: target.value };
    await props.entry.controller.call('calibrate_co2', params);
    if (mode.value === 'reset') msg.value = { ok: true, text: t('drawer.sent') };
    else props.entry.controller.setOp('co2cal');
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  }
}
</script>

<template>
  <section class="sec">
    <h3 class="sec__title">{{ t('drawer.co2') }}</h3>
    <p class="sec__hint">{{ t('drawer.co2Hint') }}</p>
    <div class="row">
      <select v-model="mode" :disabled="!online || running">
        <option v-for="m in ['forced', 'factory', 'reset'] as const" :key="m" :value="m">
          {{ t(`drawer.co2Modes.${m}` as MessageKey) }}
        </option>
      </select>
      <label v-if="mode !== 'reset'">
        {{ t('drawer.co2Target') }}
        <input v-model.number="target" type="number" min="300" max="5000" step="1" :disabled="!online || running" />
        ppm
      </label>
    </div>
    <p v-if="mode === 'factory'" class="msg warn">{{ t('drawer.co2FactoryWarn') }}</p>
    <p v-if="s.logging" class="msg muted">{{ t('drawer.co2Logging') }}</p>
    <template v-if="running && progress && progress.state === 'measuring'">
      <div class="progress"><div class="progress__bar" :style="{ width: `${Math.max(0, 100 - (progress.remaining_s / 35) * 100)}%` }" /></div>
      <p class="msg muted num">{{ t('drawer.co2Progress', { s: progress.remaining_s, ppm: progress.current_ppm }) }}</p>
    </template>
    <div class="actions">
      <button class="btn btn--small" :disabled="!online || !!s.logging || running || !validTarget" @click="confirm = true">
        {{ t('drawer.co2Start') }}
      </button>
    </div>
    <p v-if="msg" class="msg" :class="msg.ok ? 'ok' : 'warn'" role="status">{{ msg.text }}</p>
    <ConfirmDialog
      :open="confirm"
      :title="t('drawer.co2Confirm')"
      :body="t(`drawer.co2Modes.${mode}` as MessageKey)"
      :confirm-label="t('drawer.co2Start')"
      @confirm="start"
      @cancel="confirm = false"
    />
  </section>
</template>

<style scoped src="./drawer.css"></style>
