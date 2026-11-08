<script setup lang="ts">
import { defineAsyncComponent, onMounted } from 'vue';
import AppHeader from './app/components/layout/AppHeader.vue';
import AppFooter from './app/components/layout/AppFooter.vue';
// The drawer (settings, downloads, calibration) loads on first use.
const DeviceDrawer = defineAsyncComponent(() => import('./app/components/drawer/DeviceDrawer.vue'));
import { useUnloadGuard } from './app/composables/useAppGuards';
import { useWakeLock } from './app/composables/useWakeLock';
import { initAppStatus } from './app/composables/useAppStatus';
import { useDevicesStore } from './app/stores/devices';
import { useRecordingStore } from './app/stores/recording';

const devices = useDevicesStore();
const recording = useRecordingStore();
initAppStatus();
useUnloadGuard(() => devices.anyActive || !!recording.active);
// Keep the screen on while recording, downloading or calibrating.
useWakeLock(() => !!recording.active || devices.entries.some((e) => e.state.value.op !== null));
onMounted(() => {
  void devices.checkAvailability();
  void devices.findRestorable();
  void recording.init();
});

if (import.meta.env.DEV) Object.assign(window, { __mwebDevices: devices, __mwebRecording: recording });
</script>

<template>
  <AppHeader />
  <main>
    <RouterView />
  </main>
  <AppFooter />
  <DeviceDrawer />
</template>
