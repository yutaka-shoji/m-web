<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { SessionRecord } from '../../core/data/db';
import ConfirmDialog from '../components/ui/ConfirmDialog.vue';
import { useAppStatus } from '../composables/useAppStatus';
import { downloadBlob, formatBytes, runExport } from '../export';
import { formatDuration } from '../format';
import { locale, t, type MessageKey } from '../i18n';
import { useDumpsStore } from '../stores/dumps';
import { useRecordingStore } from '../stores/recording';
import { useSettingsStore } from '../stores/settings';

const rec = useRecordingStore();
const dumps = useDumpsStore();
const settings = useSettingsStore();
const app = useAppStatus();
const progress = reactive<Record<string, number>>({});
const message = ref<string | null>(null);
const errorMsg = ref<string | null>(null);
const opts = reactive({ voltage: false, long: false });
const toDelete = ref<SessionRecord | null>(null);

onMounted(async () => {
  await rec.init();
  await rec.refresh();
  await rec.estimate();
  await dumps.refresh();
});

async function downloadDump(id: string) {
  const d = dumps.list.find((x) => x.id === id);
  if (!d) return;
  message.value = null;
  errorMsg.value = null;
  try {
    const rows = await dumps.exportCsv(d, opts.voltage);
    message.value = t('data.exported', { rows: rows.toLocaleString() });
  } catch (e) {
    errorMsg.value = t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) });
  }
}

const dtf = computed(
  () => new Intl.DateTimeFormat(locale.value === 'ja' ? 'ja-JP' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
);

function period(s: SessionRecord): string {
  const end = s.endedAt ?? Date.now();
  return `${dtf.value.format(s.startedAt)} – ${formatDuration((end - s.startedAt) / 1000)}`;
}

async function download(s: SessionRecord) {
  message.value = null;
  errorMsg.value = null;
  progress[s.id] = 0;
  try {
    const res = await runExport(
      {
        kind: 'session',
        sessionId: s.id,
        options: {
          conditions: { ...settings.conditions },
          voltage: opts.voltage,
          layout: opts.long ? 'long' : 'per-device',
        },
        zip: !opts.long && s.devices.length > 1,
        appVersion: __APP_VERSION__,
      },
      (done, total) => (progress[s.id] = total ? Math.round((done / total) * 100) : 0),
    );
    downloadBlob(res.blob, res.filename);
    message.value = t('data.exported', { rows: res.rows.toLocaleString() });
  } catch (e) {
    errorMsg.value = t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    delete progress[s.id];
  }
}

const resuming = ref(false);

async function resume(s: SessionRecord) {
  message.value = null;
  errorMsg.value = null;
  resuming.value = true;
  try {
    await rec.resume(s.id);
  } catch (e) {
    errorMsg.value = t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    resuming.value = false;
  }
}

async function confirmDelete() {
  const s = toDelete.value;
  toDelete.value = null;
  if (s) await rec.remove(s.id);
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h1 class="head__title">{{ t('data.title') }}</h1>
      <p v-if="rec.storage" class="head__sub">
        {{ t('data.storage', { usage: formatBytes(rec.storage.usage), quota: formatBytes(rec.storage.quota) }) }}
        · {{ rec.storage.persisted ? t('data.persisted') : t('data.notPersisted') }}
      </p>
    </header>

    <section class="block">
      <div class="block__head">
        <h2 class="block__title">{{ t('data.sessions') }}</h2>
        <div class="opts">
          <label><input v-model="opts.long" type="checkbox" /> {{ t('data.longFormat') }}</label>
          <label><input v-model="opts.voltage" type="checkbox" /> {{ t('data.includeVoltage') }}</label>
        </div>
      </div>
      <p class="note">
        {{ t('data.conditionsNote', { clo: settings.conditions.clo.toFixed(1), met: settings.conditions.met.toFixed(1) }) }}
      </p>
      <p v-if="message" class="note note--ok" role="status">{{ message }}</p>
      <p v-if="errorMsg" class="note note--warn" role="alert">{{ errorMsg }}</p>

      <table v-if="rec.sessions.length" class="table">
        <thead>
          <tr>
            <th scope="col">{{ t('recording.titleLabel') }}</th>
            <th scope="col">{{ t('data.period') }}</th>
            <th scope="col">{{ t('data.devices') }}</th>
            <th scope="col" class="r">{{ t('data.samples') }}</th>
            <th scope="col"><span class="visually-hidden">{{ t('data.download') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in rec.sessions" :key="s.id">
            <td>
              <span class="title">{{ s.title }}</span>
              <span class="status" :class="`status--${s.status}`">{{ t(`data.status.${s.status}` as MessageKey) }}</span>
            </td>
            <td class="num muted">{{ period(s) }}</td>
            <td>
              <span v-for="d in s.devices" :key="d.hardwareId" class="dev">
                <span class="dev__dot" :style="{ background: `var(--series-${d.colorIndex + 1})` }" aria-hidden="true" />
                {{ d.name }}
              </span>
            </td>
            <td class="r num">{{ s.samples.toLocaleString() }}</td>
            <td class="actions">
              <span v-if="progress[s.id] !== undefined" class="muted">{{ t('data.exporting', { pct: progress[s.id]! }) }}</span>
              <template v-else>
                <button
                  v-if="s.status === 'interrupted' && !rec.active && app.tabRole !== 'secondary'"
                  class="btn btn--small"
                  :disabled="resuming"
                  @click="resume(s)"
                >
                  {{ t('data.resume') }}
                </button>
                <button class="btn btn--small" data-testid="download" :disabled="s.samples === 0" @click="download(s)">
                  {{ opts.long || s.devices.length <= 1 ? t('data.downloadCsv') : t('data.downloadZip') }}
                </button>
                <button
                  class="btn btn--small btn--quiet"
                  :disabled="s.status === 'recording'"
                  @click="toDelete = s"
                >
                  {{ t('data.delete') }}
                </button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">{{ t('data.empty') }}</p>
    </section>

    <section v-if="dumps.list.length" class="block block--dumps">
      <h2 class="block__title">{{ t('drawer.memory') }}</h2>
      <table class="table">
        <thead>
          <tr>
            <th scope="col">{{ t('data.devices') }}</th>
            <th scope="col">{{ t('data.period') }}</th>
            <th scope="col" class="r">{{ t('data.samples') }}</th>
            <th scope="col"><span class="visually-hidden">{{ t('data.download') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in dumps.list" :key="d.id">
            <td>
              <span class="title">{{ d.name }}</span>
              <span class="status" :class="{ 'status--interrupted': d.status !== 'done' }">
                {{ t(`drawer.dumpStatus.${d.status}` as MessageKey) }}
              </span>
            </td>
            <td class="num muted">{{ dtf.format(d.startedAt) }}</td>
            <td class="r num">{{ d.total.toLocaleString() }}</td>
            <td class="actions">
              <button class="btn btn--small" :disabled="d.status !== 'done'" @click="downloadDump(d.id)">
                {{ t('data.downloadCsv') }}
              </button>
              <button class="btn btn--small btn--quiet" :disabled="d.status === 'running'" @click="dumps.remove(d.id)">
                {{ t('data.delete') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <ConfirmDialog
      :open="!!toDelete"
      :title="t('data.deleteTitle', { title: toDelete?.title ?? '' })"
      :body="t('data.deleteBody')"
      :confirm-label="t('data.deleteConfirm')"
      danger
      @confirm="confirmDelete"
      @cancel="toDelete = null"
    />
  </section>
</template>

<style scoped>
.head {
  margin-bottom: var(--sp-6);
}
.head__title {
  font-size: var(--fs-xl);
}
.head__sub {
  margin-top: 2px;
  color: var(--c-fg-subtle);
  font-size: var(--fs-s);
}
.block__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
}
.block__title {
  font-size: var(--fs-l);
}
.opts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4);
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
}
.opts label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.note {
  margin-top: var(--sp-2);
  color: var(--c-fg-subtle);
  font-size: var(--fs-s);
}
.note--ok {
  color: var(--c-accent);
}
.note--warn {
  color: var(--c-warn);
}
.table {
  width: 100%;
  margin-top: var(--sp-5);
  border-collapse: collapse;
  font-size: var(--fs-m);
}
.table th {
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-line-strong);
  color: var(--c-fg-muted);
  font-size: var(--fs-s);
  font-weight: 500;
  text-align: left;
}
.table td {
  padding: var(--sp-3);
  border-bottom: 1px solid var(--c-line);
  vertical-align: middle;
}
.r {
  text-align: right !important;
}
.muted {
  color: var(--c-fg-muted);
}
.title {
  margin-right: var(--sp-2);
  font-weight: 500;
}
.status {
  color: var(--c-fg-subtle);
  font-size: var(--fs-xs);
}
.status--recording {
  color: var(--c-accent);
}
.status--interrupted {
  color: var(--c-warn);
}
.dev {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: var(--sp-3);
  white-space: nowrap;
  font-size: var(--fs-s);
}
.dev__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-1);
  white-space: nowrap;
}
.block--dumps {
  margin-top: var(--sp-8);
}
.empty {
  margin-top: var(--sp-6);
  color: var(--c-fg-muted);
}
@media (max-width: 760px) {
  .table thead {
    display: none;
  }
  .table tr {
    display: grid;
    gap: 4px;
    padding: var(--sp-3) 0;
    border-bottom: 1px solid var(--c-line);
  }
  .table td {
    padding: 0;
    border: 0;
  }
  .actions {
    justify-content: flex-start;
  }
}
</style>
