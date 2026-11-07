import { onBeforeUnmount, onMounted } from 'vue';

/**
 * Warn before closing/reloading the tab while `active()` is true: leaving the page drops
 * every Bluetooth connection (and with it any BLE-only logging).
 */
export function useUnloadGuard(active: () => boolean): void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!active()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));
}
