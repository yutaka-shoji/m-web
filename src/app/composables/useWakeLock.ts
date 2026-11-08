import { onBeforeUnmount, watch } from 'vue';

/**
 * Holds a screen wake lock while `wanted()` is true. A request takes a moment to be granted,
 * and the answer can come after the lock stopped being wanted (recording stopped, page hidden):
 * such a lock is released at once instead of keeping the screen on.
 */
export class WakeLockHolder {
  private sentinel: WakeLockSentinel | null = null;
  private requesting = false;
  private readonly wanted: () => boolean;
  private readonly request: () => Promise<WakeLockSentinel>;

  constructor(wanted: () => boolean, request: () => Promise<WakeLockSentinel>) {
    this.wanted = wanted;
    this.request = request;
  }

  get held(): boolean {
    return this.sentinel !== null;
  }

  /** Acquire or release to match `wanted()`; call whenever that may have changed. */
  async sync(): Promise<void> {
    if (!this.wanted()) {
      const s = this.sentinel;
      this.sentinel = null;
      await s?.release().catch(() => {});
      return;
    }
    if (this.sentinel || this.requesting) return;
    this.requesting = true;
    let s: WakeLockSentinel;
    try {
      s = await this.request();
    } catch {
      return; // e.g. battery saver: not fatal
    } finally {
      this.requesting = false;
    }
    if (!this.wanted()) {
      await s.release().catch(() => {});
      return;
    }
    this.sentinel = s;
    s.addEventListener('release', () => {
      if (this.sentinel === s) this.sentinel = null;
    });
  }
}

/**
 * Keep the screen on while `active()` (recording, downloading, calibrating) and the page is
 * visible — display sleep often leads to system sleep, which drops every Bluetooth link.
 * The browser releases the lock when the page is hidden, so it is re-acquired when the page
 * becomes visible again.
 */
export function useWakeLock(active: () => boolean): void {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
  let unmounted = false;
  const lock = new WakeLockHolder(
    () => !unmounted && active() && document.visibilityState === 'visible',
    () => navigator.wakeLock.request('screen'),
  );
  watch(active, () => void lock.sync(), { immediate: true });
  const onVisibility = () => void lock.sync();
  document.addEventListener('visibilitychange', onVisibility);
  onBeforeUnmount(() => {
    unmounted = true;
    document.removeEventListener('visibilitychange', onVisibility);
    void lock.sync();
  });
}
