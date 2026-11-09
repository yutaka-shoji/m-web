<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { CATEGORY_KEYS, type CategoryKey, type Settings } from '../../../core/protocol/types';
import { t, type MessageKey } from '../../i18n';
import type { DeviceEntry } from '../../stores/devices';

const props = defineProps<{ entry: DeviceEntry; online: boolean }>();
const settings = computed(() => props.entry.state.value.meta.settings);
const draft = reactive({
  general: { enabled: true, interval: 60 },
  velocity: { enabled: false, interval: 60 },
  illuminance: { enabled: false, interval: 60 },
  start: 'now' as 'now' | 'at',
  startAt: '',
});
const busy = ref(false);
const msg = ref<{ ok: boolean; text: string } | null>(null);

function load(s: Settings | null) {
  if (!s) return;
  for (const k of CATEGORY_KEYS) Object.assign(draft[k], s[k]);
  const future = s.start_ts * 1000 > Date.now();
  draft.start = future ? 'at' : 'now';
  draft.startAt = future ? toLocalInput(new Date(s.start_ts * 1000)) : '';
}
watch(settings, (s) => load(s), { immediate: true });

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const intervalsValid = computed(() =>
  CATEGORY_KEYS.every((k) => Number.isInteger(draft[k].interval) && draft[k].interval >= 1 && draft[k].interval <= 86400),
);

/** `start_ts` to send: 0 = immediately; null = "at a set time" without a usable future time. */
function startTs(): number | null {
  if (draft.start === 'now') return 0;
  const ms = new Date(draft.startAt).getTime(); // '' (not filled in) → NaN
  return Number.isFinite(ms) && ms > Date.now() ? Math.floor(ms / 1000) : null;
}
const startValid = computed(() => startTs() !== null);
const valid = computed(() => intervalsValid.value && startValid.value);

async function send() {
  if (!valid.value) return;
  const start_ts = startTs(); // checked again: the chosen time may have passed meanwhile
  if (start_ts === null) {
    msg.value = { ok: false, text: t('drawer.startAtInvalid') };
    return;
  }
  busy.value = true;
  msg.value = null;
  try {
    const patch: Partial<Record<CategoryKey, { enabled: boolean; interval: number }>> & { start_ts: number } = { start_ts };
    for (const k of CATEGORY_KEYS) patch[k] = { enabled: draft[k].enabled, interval: draft[k].interval };
    await props.entry.controller.setSettings(patch);
    msg.value = { ok: true, text: t('drawer.sent') };
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  } finally {
    busy.value = false;
  }
}

async function reload() {
  busy.value = true;
  try {
    load(await props.entry.controller.refreshSettings());
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="sec">
    <h3 class="sec__title">{{ t('drawer.settings') }}</h3>
    <div v-for="k in CATEGORY_KEYS" :key="k" class="row">
      <label class="grow">
        <input v-model="draft[k].enabled" type="checkbox" :disabled="!online" />
        {{ t(`drawer.categories.${k}` as MessageKey) }}
      </label>
      <label>
        {{ t('drawer.interval') }}
        <input v-model.number="draft[k].interval" type="number" min="1" max="86400" step="1" :disabled="!online || !draft[k].enabled" />
        {{ t('drawer.seconds') }}
      </label>
    </div>
    <div class="row">
      <span class="muted">{{ t('drawer.startAt') }}</span>
      <label><input v-model="draft.start" type="radio" value="now" :disabled="!online" /> {{ t('drawer.startNow') }}</label>
      <label><input v-model="draft.start" type="radio" value="at" :disabled="!online" /> {{ t('drawer.startScheduled') }}</label>
      <input v-if="draft.start === 'at'" v-model="draft.startAt" type="datetime-local" :disabled="!online" />
    </div>
    <p v-if="!intervalsValid" class="msg warn">{{ t('drawer.intervalRange') }}</p>
    <p v-if="!startValid" class="msg warn">{{ t('drawer.startAtInvalid') }}</p>
    <div class="actions">
      <button class="btn btn--small btn--primary" :disabled="!online || busy || !valid" @click="send">{{ t('drawer.send') }}</button>
      <button class="btn btn--small btn--quiet" :disabled="!online || busy" @click="reload">{{ t('drawer.reload') }}</button>
    </div>
    <p v-if="msg" class="msg" :class="msg.ok ? 'ok' : 'warn'" role="status">{{ msg.text }}</p>
  </section>
</template>

<style scoped src="./drawer.css"></style>
