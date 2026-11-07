<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { CORRECTION_KEYS, type Correction, type CorrectionKey, type CorrectionPatch } from '../../../core/protocol/types';
import { t, type MessageKey } from '../../i18n';
import type { DeviceEntry } from '../../stores/devices';

const props = defineProps<{ entry: DeviceEntry; online: boolean }>();

/** Accepted ranges (protocol v4 §4.5). */
const RANGES: Record<CorrectionKey, { a: [number, number]; b: [number, number]; step: number; label: MessageKey }> = {
  t_dry: { a: [0.8, 1.2], b: [-3, 3], step: 0.01, label: 'q.t' },
  humidity: { a: [0.8, 1.2], b: [-9.99, 9.99], step: 0.01, label: 'q.h' },
  t_glb: { a: [0.8, 1.2], b: [-3, 3], step: 0.01, label: 'q.g' },
  illuminance: { a: [0.8, 1.2], b: [-999, 999], step: 1, label: 'q.l' },
  velocity: { a: [0.8, 1.2], b: [-0.5, 0.5], step: 0.001, label: 'q.v' },
};

const current = ref<Correction | null>(null);
const draft = reactive({} as Record<CorrectionKey, { a: number; b: number }>);
const busy = ref(false);
const msg = ref<{ ok: boolean; text: string } | null>(null);

function setFrom(c: Correction) {
  current.value = c;
  for (const k of CORRECTION_KEYS) draft[k] = { a: c[k].a, b: c[k].b };
}

const invalid = computed(() =>
  CORRECTION_KEYS.filter((k) => {
    const d = draft[k];
    if (!d) return false;
    const r = RANGES[k];
    return !(d.a >= r.a[0] && d.a <= r.a[1] && d.b >= r.b[0] && d.b <= r.b[1]);
  }),
);

async function load() {
  busy.value = true;
  msg.value = null;
  try {
    setFrom(await props.entry.controller.call('get_correction', undefined));
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  } finally {
    busy.value = false;
  }
}

async function send() {
  if (!current.value || invalid.value.length) return;
  const patch: CorrectionPatch = {};
  for (const k of CORRECTION_KEYS) {
    if (k === 'velocity') continue; // not applied by current firmware
    const d = draft[k];
    if (d.a !== current.value[k].a || d.b !== current.value[k].b) patch[k] = { a: d.a, b: d.b };
  }
  if (Object.keys(patch).length === 0) return;
  busy.value = true;
  try {
    setFrom(await props.entry.controller.call('set_correction', patch));
    msg.value = { ok: true, text: t('drawer.sent') };
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="sec">
    <h3 class="sec__title">{{ t('drawer.correction') }}</h3>
    <p class="sec__hint">{{ t('drawer.correctionHint') }}</p>
    <button v-if="!current" class="btn btn--small" :disabled="!online || busy" @click="load">{{ t('drawer.load') }}</button>
    <template v-else>
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('drawer.sensor') }}</th>
            <th>a</th>
            <th>b</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in CORRECTION_KEYS" :key="k" :class="{ muted: k === 'velocity' }">
            <td>{{ t(RANGES[k].label) }}</td>
            <td>
              <input
                v-model.number="draft[k].a"
                type="number"
                step="0.001"
                :min="RANGES[k].a[0]"
                :max="RANGES[k].a[1]"
                :disabled="!online || k === 'velocity'"
              />
            </td>
            <td>
              <input
                v-model.number="draft[k].b"
                type="number"
                :step="RANGES[k].step"
                :min="RANGES[k].b[0]"
                :max="RANGES[k].b[1]"
                :disabled="!online || k === 'velocity'"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p class="msg muted">{{ t('drawer.velocityNotApplied') }}</p>
      <p v-for="k in invalid" :key="k" class="msg warn">
        {{ t(RANGES[k].label) }}: {{ t('drawer.outOfRange', { a: RANGES[k].a.join('–'), b: RANGES[k].b.join('–') }) }}
      </p>
      <div class="actions">
        <button class="btn btn--small btn--primary" :disabled="!online || busy || invalid.length > 0" @click="send">
          {{ t('drawer.send') }}
        </button>
        <button class="btn btn--small btn--quiet" :disabled="!online || busy" @click="load">{{ t('drawer.reload') }}</button>
      </div>
    </template>
    <p v-if="msg" class="msg" :class="msg.ok ? 'ok' : 'warn'" role="status">{{ msg.text }}</p>
  </section>
</template>

<style scoped src="./drawer.css"></style>
