import { onBeforeUnmount, watch } from 'vue';

/**
 * Keep the screen on while `active()` (recording, downloading, calibrating) and the page is
 * visible — display sleep often leads to system sleep, which drops every Bluetooth link.
 * The lock is released automatically by the browser when the page is hidden, so it is
 * re-acquired when the page becomes visible again.
 */
export function useWakeLock(active: () => boolean): void {
  let sentinel: WakeLockSentinel | null = null;

  async function acquire(): Promise<void> {
    if (sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => (sentinel = null));
    } catch {
      sentinel = null; // e.g. battery saver: not fatal
    }
  }

  async function release(): Promise<void> {
    const s = sentinel;
    sentinel = null;
    await s?.release().catch(() => {});
  }

  watch(active, (on) => void (on ? acquire() : release()), { immediate: true });
  const onVisible = () => {
    if (document.visibilityState === 'visible' && active()) void acquire();
  };
  document.addEventListener('visibilitychange', onVisible);
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisible);
    void release();
  });
}
