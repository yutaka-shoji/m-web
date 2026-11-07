<script setup lang="ts">
import { computed, ref } from 'vue';
import { useNow } from '../../composables/useNow';
import { formatDuration } from '../../format';
import { t } from '../../i18n';
import { useDevicesStore } from '../../stores/devices';
import { useRecordingStore } from '../../stores/recording';
import ConfirmDialog from '../ui/ConfirmDialog.vue';

const rec = useRecordingStore();
const devices = useDevicesStore();
const now = useNow();
const title = ref('');
const flash = ref(true);
const busy = ref(false);
const err = ref<string | null>(null);
const confirmOpen = ref(false);
const stopDevices = ref(true);

const pad = (n: number) => String(n).padStart(2, '0');
const defaultTitle = computed(() => {
  const d = new Date(now.value);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return t('recording.titlePlaceholder', { date });
});
const online = computed(() => devices.entries.filter((e) => e.state.value.conn.state === 'online').length);
const members = computed(() => rec.active?.devices.filter((d) => d.leftAt === null).length ?? 0);
const elapsed = computed(() => (rec.active ? formatDuration((now.value - rec.active.startedAt) / 1000) : ''));
const sampleCount = computed(() => rec.samples.toLocaleString());

async function start() {
  busy.value = true;
  err.value = null;
  try {
    await rec.start({ title: title.value.trim() || defaultTitle.value, flash: flash.value });
    title.value = '';
  } catch (e) {
    err.value = t('recording.error', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}

async function stop() {
  confirmOpen.value = false;
  busy.value = true;
  try {
    await rec.stop({ stopDevices: stopDevices.value });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="rec" :class="{ 'is-active': rec.active }" :aria-label="t('recording.title')">
    <template v-if="rec.active">
      <span class="rec__live" role="status">
        <span class="rec__dot" aria-hidden="true" />
        {{ t('recording.recording') }}
      </span>
      <span class="rec__time num">{{ elapsed }}</span>
      <span class="rec__title">{{ rec.active.title }}</span>
      <span class="rec__meta">
        {{ t('recording.devices', { n: members }) }} · <span class="num">{{ t('recording.samples', { n: sampleCount }) }}</span>
      </span>
      <button class="btn rec__stop" :disabled="busy" data-testid="stop-recording" @click="confirmOpen = true">
        {{ t('recording.stop') }}
      </button>
    </template>
    <template v-else>
      <label class="visually-hidden" for="rec-title">{{ t('recording.titleLabel') }}</label>
      <input id="rec-title" v-model="title" class="rec__input" type="text" :placeholder="defaultTitle" maxlength="80" />
      <label class="rec__check" :title="t('recording.flashHint')">
        <input v-model="flash" type="checkbox" />
        {{ t('recording.flash') }}
      </label>
      <button
        class="btn btn--primary rec__start"
        :disabled="!online || busy"
        :title="!online ? t('recording.noDevice') : undefined"
        data-testid="start-recording"
        @click="start"
      >
        <span class="rec__dot rec__dot--on-accent" aria-hidden="true" />
        {{ busy ? t('recording.starting') : t('recording.start') }}
      </button>
    </template>
  </section>
  <p v-if="err" class="rec__error" role="alert">{{ err }}</p>
  <p v-if="rec.error === 'quota'" class="rec__error" role="alert">{{ t('recording.quota') }}</p>

  <ConfirmDialog
    :open="confirmOpen"
    :title="t('recording.stopTitle')"
    :confirm-label="t('recording.stopConfirm')"
    @confirm="stop"
    @cancel="confirmOpen = false"
  >
    <label class="rec__check">
      <input v-model="stopDevices" type="checkbox" />
      {{ t('recording.stopDevices') }}
    </label>
  </ConfirmDialog>
</template>

<style scoped>
.rec {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3) var(--sp-5);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--c-line);
  border-radius: var(--radius);
}
.rec.is-active {
  border-color: color-mix(in srgb, var(--c-accent) 35%, var(--c-line));
  background: var(--c-accent-weak);
}
.rec__live {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--c-accent);
  font-weight: 600;
}
.rec__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--c-accent);
  animation: pulse 1.6s var(--ease) infinite;
}
.rec__dot--on-accent {
  background: var(--c-on-accent);
  animation: none;
}
.rec__time {
  font-size: var(--fs-l);
}
.rec__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rec__meta {
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
}
.rec__stop {
  margin-left: auto;
}
.rec__input {
  flex: 1 1 260px;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--radius);
  background: var(--c-bg);
}
.rec__check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
  cursor: pointer;
}
.rec__start {
  margin-left: auto;
}
.rec__error {
  margin-top: var(--sp-2);
  color: var(--c-warn);
  font-size: var(--fs-s);
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
