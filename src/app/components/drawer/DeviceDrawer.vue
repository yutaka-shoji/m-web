<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { t } from '../../i18n';
import { useDevicesStore } from '../../stores/devices';
import DrawerCo2 from './DrawerCo2.vue';
import DrawerCorrection from './DrawerCorrection.vue';
import DrawerMemory from './DrawerMemory.vue';
import DrawerOverview from './DrawerOverview.vue';
import DrawerRename from './DrawerRename.vue';
import DrawerSettings from './DrawerSettings.vue';

const route = useRoute();
const router = useRouter();
const devices = useDevicesStore();
const panel = ref<HTMLElement>();

const key = computed(() => (typeof route.query.device === 'string' ? route.query.device : null));
const entry = computed(() => devices.entries.find((e) => e.key === key.value) ?? null);
const online = computed(() => entry.value?.state.value.conn.state === 'online');
const name = computed(() => {
  const s = entry.value?.state.value;
  return s ? (s.meta.name ?? s.bleName ?? s.key) : '';
});

function close() {
  const { device: _d, ...rest } = route.query;
  void router.replace({ query: rest });
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && entry.value && !document.querySelector('dialog[open]')) close();
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
watch(entry, (e) => e && setTimeout(() => panel.value?.focus(), 0));
</script>

<template>
  <Transition name="drawer">
    <div v-if="entry" class="overlay" @click.self="close">
      <aside ref="panel" class="panel" role="dialog" aria-modal="true" :aria-label="t('drawer.title')" tabindex="-1">
        <header class="panel__head">
          <span class="panel__dot" :style="{ background: `var(--series-${entry.colorIndex + 1})` }" aria-hidden="true" />
          <div class="panel__title">
            <p class="eyebrow">{{ t('drawer.title') }}</p>
            <h2>{{ name }}</h2>
          </div>
          <button class="btn btn--quiet btn--small" @click="close">{{ t('drawer.close') }}</button>
        </header>
        <p v-if="!online" class="panel__note">{{ t('drawer.notConnected') }}</p>
        <DrawerOverview :entry="entry" :online="online" />
        <DrawerSettings :entry="entry" :online="online" />
        <DrawerMemory :entry="entry" :online="online" />
        <DrawerCorrection :entry="entry" :online="online" />
        <DrawerCo2 :entry="entry" :online="online" />
        <DrawerRename :entry="entry" :online="online" />
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--c-overlay);
}
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(500px, 100vw);
  overflow-y: auto;
  padding: var(--sp-5) var(--sp-5) var(--sp-7);
  background: var(--c-bg);
  border-left: 1px solid var(--c-line);
  box-shadow: -12px 0 40px rgb(0 0 0 / 8%);
  outline: none;
}
.panel__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.panel__dot {
  width: 10px;
  height: 10px;
  margin-top: 26px;
  border-radius: 50%;
  flex: none;
}
.panel__title {
  flex: 1;
  min-width: 0;
}
.panel__title h2 {
  font-size: var(--fs-xl);
  overflow-wrap: anywhere;
}
.panel__note {
  margin-bottom: var(--sp-3);
  color: var(--c-warn);
  font-size: var(--fs-s);
}
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 160ms var(--ease);
}
.drawer-enter-active .panel,
.drawer-leave-active .panel {
  transition: transform 200ms var(--ease);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .panel,
.drawer-leave-to .panel {
  transform: translateX(24px);
}
</style>
