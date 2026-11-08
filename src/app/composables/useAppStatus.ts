import { reactive, readonly } from 'vue';

export type TabRole = 'primary' | 'secondary' | 'unknown';

interface AppStatus {
  /** 'secondary' when another tab already holds the devices (Web Locks). */
  tabRole: TabRole;
  /** Web Bluetooth needs a secure context (HTTPS or localhost). */
  secure: boolean;
}

const status = reactive<AppStatus>({
  tabRole: 'unknown',
  secure: typeof window === 'undefined' ? true : window.isSecureContext,
});

let roleKnown: Promise<TabRole> | null = null;

/**
 * Call once at startup: acquires the single-tab lock for the lifetime of the page. Resolves
 * with this tab's role ('unknown' where the Web Locks API is missing).
 */
export function initAppStatus(): Promise<TabRole> {
  if (roleKnown) return roleKnown;
  if (typeof navigator === 'undefined' || !('locks' in navigator))
    return (roleKnown = Promise.resolve('unknown'));
  roleKnown = new Promise<TabRole>((resolve) => {
    navigator.locks
      .request('m-web-primary', { ifAvailable: true }, async (lock) => {
        status.tabRole = lock ? 'primary' : 'secondary';
        resolve(status.tabRole);
        if (lock) await new Promise<never>(() => {}); // hold until the page goes away
      })
      .catch(() => resolve('unknown'));
  });
  return roleKnown;
}

/**
 * Whether this tab may record and download. Only the tab holding the devices does, so in any
 * other tab a session still marked 'recording' or a download marked 'running' belongs to that
 * tab and must be left alone. Without Web Locks the tab is taken to be the only one.
 */
export async function ownsDeviceWork(): Promise<boolean> {
  return (await initAppStatus()) !== 'secondary';
}

export function useAppStatus(): Readonly<AppStatus> {
  return readonly(status);
}
