import { reactive, readonly } from 'vue';

interface AppStatus {
  /** 'secondary' when another tab already holds the devices (Web Locks). */
  tabRole: 'primary' | 'secondary' | 'unknown';
  /** Web Bluetooth needs a secure context (HTTPS or localhost). */
  secure: boolean;
}

const status = reactive<AppStatus>({
  tabRole: 'unknown',
  secure: typeof window === 'undefined' ? true : window.isSecureContext,
});

let started = false;

/** Call once at startup: acquires the single-tab lock for the lifetime of the page. */
export function initAppStatus(): void {
  if (started || typeof navigator === 'undefined' || !('locks' in navigator)) return;
  started = true;
  void navigator.locks.request('m-web-primary', { ifAvailable: true }, async (lock) => {
    if (!lock) {
      status.tabRole = 'secondary';
      return;
    }
    status.tabRole = 'primary';
    await new Promise<never>(() => {}); // hold until the page goes away
  });
}

export function useAppStatus(): Readonly<AppStatus> {
  return readonly(status);
}
