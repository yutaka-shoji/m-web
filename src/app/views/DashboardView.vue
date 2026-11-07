<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue';
import ConditionsBar from '../components/devices/ConditionsBar.vue';
import RecordingBar from '../components/recording/RecordingBar.vue';
import { useRecordingStore } from '../stores/recording';
import DeviceCard from '../components/devices/DeviceCard.vue';
import AppBanner from '../components/ui/AppBanner.vue';
import { t } from '../i18n';
import { useDevicesStore } from '../stores/devices';
import { useAppStatus } from '../composables/useAppStatus';

// uPlot and the chart code load after the first paint.
const ChartStack = defineAsyncComponent(() => import('../components/charts/ChartStack.vue'));
const store = useDevicesStore();
const rec = useRecordingStore();
const app = useAppStatus();
const adding = ref(false);
const addError = ref<string | null>(null);

const total = computed(() => store.entries.length);
const onlineIdle = computed(() =>
  store.entries.filter((e) => e.state.value.conn.state === 'online' && !e.state.value.logging),
);
const onlineLogging = computed(() =>
  store.entries.filter((e) => e.state.value.conn.state === 'online' && e.state.value.logging),
);

async function add() {
  adding.value = true;
  addError.value = null;
  try {
    await store.addBluetoothDevice();
  } catch (e) {
    addError.value = t('error.addFailed', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    adding.value = false;
  }
}

async function findLost() {
  adding.value = true;
  addError.value = null;
  try {
    await store.findLostDevices();
  } catch (e) {
    addError.value = t('error.addFailed', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    adding.value = false;
  }
}

async function liveAll() {
  await Promise.allSettled(onlineIdle.value.map((e) => e.controller.startLive()));
}
async function stopAll() {
  await Promise.allSettled(onlineLogging.value.map((e) => e.controller.stopLogging()));
}
</script>

<template>
  <section class="page">
    <header class="head">
      <div>
        <h1 class="head__title">{{ t('dashboard.title') }}</h1>
        <p class="head__sub">
          <template v-if="total">
            {{ t('dashboard.countConnected', { n: store.connectedCount }) }}
            <span class="sep">/</span>
            {{ t('dashboard.countTotal', { n: total }) }}
          </template>
        </p>
      </div>
      <div class="head__actions">
        <button v-if="onlineLogging.length > 1" class="btn btn--quiet" data-testid="stop-all" @click="stopAll">
          {{ t('dashboard.stopAll') }}
        </button>
        <button v-if="onlineIdle.length > 1" class="btn" data-testid="live-all" @click="liveAll">
          {{ t('dashboard.liveAll') }}
        </button>
        <button v-if="total" class="btn btn--quiet" data-testid="add-demo" @click="store.addDemoDevices()">
          {{ t('dashboard.addDemo') }}
        </button>
        <button
          class="btn btn--primary"
          data-testid="add-device"
          :disabled="!store.supported || adding || app.tabRole === 'secondary'"
          :title="t('dashboard.chooserHint')"
          @click="add"
        >
          ＋ {{ t('dashboard.addDevice') }}
        </button>
      </div>
    </header>

    <div class="banners">
      <AppBanner v-if="!store.supported" tone="warn">{{ t('banner.unsupported') }}</AppBanner>
      <AppBanner v-else-if="!app.secure" tone="warn">{{ t('banner.insecure') }}</AppBanner>
      <AppBanner v-else-if="store.bluetoothAvailable === false" tone="warn">{{ t('banner.bluetoothOff') }}</AppBanner>
      <AppBanner v-if="app.tabRole === 'secondary'" tone="warn">{{ t('banner.otherTab') }}</AppBanner>
      <AppBanner v-if="addError" tone="warn">{{ addError }}</AppBanner>
      <AppBanner v-if="store.lostCount" :tone="store.autoFind ? 'info' : 'warn'">
        {{ t(store.autoFind ? 'banner.lostAuto' : 'banner.lost', { n: store.lostCount }) }}
        <span class="banner-actions">
          <button
            class="btn btn--small"
            :class="{ 'btn--primary': !store.autoFind }"
            data-testid="find-lost"
            :disabled="adding || app.tabRole === 'secondary'"
            @click="findLost"
          >
            {{ t('device.actions.find') }}
          </button>
        </span>
      </AppBanner>
      <AppBanner v-if="store.restorable.length">
        {{ t('restore.available', { n: store.restorable.length }) }}
        <span class="banner-actions">
          <button class="btn btn--small btn--primary" @click="store.reconnectRestorable()">{{ t('restore.reconnect') }}</button>
        </span>
      </AppBanner>
      <AppBanner v-for="s in rec.active ? [] : rec.interrupted" :key="s.id" tone="warn">
        {{ t('recording.interrupted', { title: s.title }) }}
        <span class="banner-actions">
          <button class="btn btn--small" :disabled="!store.connectedCount" @click="rec.resume(s.id)">
            {{ t('recording.resume') }}
          </button>
          <RouterLink class="btn btn--small btn--quiet" to="/data">{{ t('recording.viewData') }}</RouterLink>
          <button class="btn btn--small btn--quiet" @click="rec.dismissInterrupted(s.id)">{{ t('recording.dismiss') }}</button>
        </span>
      </AppBanner>
    </div>

    <div v-if="!total" class="empty">
      <h2 class="empty__title">{{ t('dashboard.emptyTitle') }}</h2>
      <p class="empty__body">{{ t('dashboard.emptyBody') }}</p>
      <div class="empty__actions">
        <button class="btn btn--primary" data-testid="add-device-empty" :disabled="!store.supported || adding" @click="add">
          ＋ {{ t('dashboard.addDevice') }}
        </button>
        <button class="btn" data-testid="add-demo-empty" @click="store.addDemoDevices()">{{ t('dashboard.addDemo') }}</button>
        <RouterLink class="btn btn--quiet" to="/guide">{{ t('dashboard.emptyGuide') }}</RouterLink>
      </div>
      <p class="empty__hint">{{ t('dashboard.chooserHint') }}</p>
    </div>

    <template v-else>
      <RecordingBar />
      <ConditionsBar class="conditions" />
      <div class="grid">
        <DeviceCard v-for="e in store.entries" :key="e.key" :entry="e" />
      </div>
      <ChartStack />
    </template>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  margin-bottom: var(--sp-5);
}
.head__title {
  font-size: var(--fs-xl);
  font-weight: 600;
}
.head__sub {
  min-height: 1.6em;
  margin-top: 2px;
  color: var(--c-fg-subtle);
  font-size: var(--fs-s);
}
.sep {
  margin: 0 6px;
  color: var(--c-line-strong);
}
.head__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.banners {
  display: grid;
  gap: var(--sp-2);
  margin-bottom: var(--sp-5);
}
.banners:empty {
  display: none;
}
.conditions {
  margin: var(--sp-5) 0;
}
.banner-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  margin-left: var(--sp-2);
  vertical-align: middle;
}
.banner-actions .btn {
  text-decoration: none;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--sp-5);
}
.empty {
  max-width: 560px;
  margin: var(--sp-8) auto;
  text-align: center;
}
.empty__title {
  font-size: var(--fs-xl);
  font-weight: 600;
}
.empty__body {
  margin-top: var(--sp-3);
  color: var(--c-fg-muted);
}
.empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-2);
  margin-top: var(--sp-6);
}
.empty__actions .btn {
  text-decoration: none;
}
.empty__hint {
  margin-top: var(--sp-5);
  color: var(--c-fg-subtle);
  font-size: var(--fs-s);
}
@media (max-width: 420px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
