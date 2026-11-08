<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { DumpRecordMeta } from '../../../core/data/db';
import { estimateDumpSeconds } from '../../../core/protocol/dump-job';
import { useAppStatus } from '../../composables/useAppStatus';
import { formatDuration } from '../../format';
import { locale, t, type MessageKey } from '../../i18n';
import type { DeviceEntry } from '../../stores/devices';
import { useDumpsStore } from '../../stores/dumps';
import ConfirmDialog from '../ui/ConfirmDialog.vue';

const props = defineProps<{ entry: DeviceEntry; online: boolean }>();
const dumps = useDumpsStore();
// Downloads run only in the tab that holds the loggers.
const app = useAppStatus();
const otherTab = computed(() => app.tabRole === 'secondary');
const s = computed(() => props.entry.state.value);
const count = ref<number | null>(null);
const msg = ref<{ ok: boolean; text: string } | null>(null);
const confirmStop = ref(false);
const confirmClear = ref(false);
const typed = ref('');
const job = computed(() => dumps.jobs[props.entry.key]);
const running = computed(() => s.value.op === 'dump');
const mine = computed(() => dumps.list.filter((d) => d.hardwareId === s.value.meta.hardwareId));
const name = computed(() => s.value.meta.name ?? '');
const dtf = computed(() => new Intl.DateTimeFormat(locale.value === 'ja' ? 'ja-JP' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }));

async function loadCount() {
  if (!props.online) return;
  try {
    count.value = (await props.entry.controller.call('get_count', undefined)).count;
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  }
}
onMounted(() => {
  void loadCount();
  void dumps.refresh();
});
watch(
  () => props.online,
  (o) => o && void loadCount(),
);

const pct = computed(() => {
  const p = job.value?.progress;
  return p && p.totalRecords ? Math.round((p.doneRecords / p.totalRecords) * 100) : 0;
});
const eta = computed(() => {
  const p = job.value?.progress;
  return p && Number.isFinite(p.etaSec) ? formatDuration(p.etaSec) : '—';
});

async function startDownload(resume?: DumpRecordMeta) {
  msg.value = null;
  if (s.value.logging) {
    confirmStop.value = true;
    return;
  }
  try {
    await dumps.start(props.entry, resume);
    if (job.value?.done) msg.value = { ok: true, text: t('drawer.downloadDone', { n: (job.value.total ?? 0).toLocaleString() }) };
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  }
}

async function stopAndDownload() {
  confirmStop.value = false;
  try {
    await props.entry.controller.stopLogging();
    await new Promise((r) => setTimeout(r, 1000));
    await startDownload();
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  }
}

async function save(d: DumpRecordMeta) {
  try {
    const rows = await dumps.exportCsv(d);
    msg.value = { ok: true, text: t('data.exported', { rows: rows.toLocaleString() }) };
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  }
}

async function clear() {
  confirmClear.value = false;
  typed.value = '';
  try {
    await props.entry.controller.call('clear_data', undefined);
    msg.value = { ok: true, text: t('drawer.cleared') };
    await loadCount();
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  }
}
</script>

<template>
  <section class="sec">
    <h3 class="sec__title">{{ t('drawer.memory') }}</h3>
    <p v-if="count !== null" class="row">
      <span class="num">{{ t('drawer.records', { n: count.toLocaleString() }) }}</span>
      <span class="muted">{{ t('drawer.estimate', { time: formatDuration(estimateDumpSeconds(count)) }) }}</span>
    </p>

    <template v-if="running && job">
      <div class="progress" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100">
        <div class="progress__bar" :style="{ width: `${pct}%` }" />
      </div>
      <p class="row muted num">
        {{
          t('drawer.downloading', {
            done: (job.progress?.doneRecords ?? 0).toLocaleString(),
            total: (job.total || 0).toLocaleString(),
            eta,
          })
        }}
        <button class="btn btn--small" @click="dumps.cancel(entry.key)">{{ t('drawer.cancel') }}</button>
      </p>
    </template>
    <div v-else class="actions">
      <button class="btn btn--small btn--primary" :disabled="!online || !count || otherTab" @click="startDownload()">
        {{ t('drawer.download') }}
      </button>
      <button class="btn btn--small btn--danger" :disabled="!online || !count || !!s.logging" @click="confirmClear = true">
        {{ t('drawer.clear') }}
      </button>
    </div>
    <p v-if="msg" class="msg" :class="msg.ok ? 'ok' : 'warn'" role="status">{{ msg.text }}</p>

    <template v-if="mine.length">
      <h4 class="sec__hint" style="margin-top: var(--sp-4)">{{ t('drawer.previous') }}</h4>
      <table class="table">
        <tbody>
          <tr v-for="d in mine" :key="d.id">
            <td class="num">{{ dtf.format(d.startedAt) }}</td>
            <td class="num">{{ t('drawer.records', { n: d.total.toLocaleString() }) }}</td>
            <td :class="{ warn: d.status === 'failed' || d.status === 'paused' }">
              {{ t(`drawer.dumpStatus.${d.status}` as MessageKey) }}
            </td>
            <td style="text-align: right; white-space: nowrap">
              <button
                v-if="(d.status === 'paused' || d.status === 'failed') && !running"
                class="btn btn--small"
                :disabled="!online || count !== d.total || otherTab"
                @click="startDownload(d)"
              >
                {{ t('drawer.resumeDownload') }}
              </button>
              <button v-if="d.status === 'done'" class="btn btn--small" @click="save(d)">{{ t('drawer.saveCsv') }}</button>
              <button class="btn btn--small btn--quiet" :disabled="running || d.status === 'running'" @click="dumps.remove(d.id)">
                {{ t('data.delete') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <ConfirmDialog
      :open="confirmStop"
      :title="t('drawer.download')"
      :body="t('drawer.stopToDownload')"
      :confirm-label="t('drawer.stopAndDownload')"
      @confirm="stopAndDownload"
      @cancel="confirmStop = false"
    />
    <ConfirmDialog
      :open="confirmClear"
      :title="t('drawer.clearTitle')"
      :body="t('drawer.clearBody', { name, n: (count ?? 0).toLocaleString() })"
      :confirm-label="t('drawer.clearConfirm')"
      danger
      :confirm-disabled="typed !== name"
      @confirm="clear()"
      @cancel="(confirmClear = false), (typed = '')"
    >
      <label class="row" style="display: grid; gap: 6px">
        <span class="muted">{{ t('drawer.clearType', { name }) }}</span>
        <input v-model="typed" type="text" autocomplete="off" />
      </label>
    </ConfirmDialog>
  </section>
</template>

<style scoped src="./drawer.css"></style>
