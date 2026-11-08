import { describe, expect, it } from 'vitest';
import { WakeLockHolder } from '../../../src/app/composables/useWakeLock';

class FakeSentinel extends EventTarget {
  released = false;
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

/** A wake-lock request the test grants by hand. */
function deferredRequests() {
  const grants: Array<(s: WakeLockSentinel) => void> = [];
  const request = () => new Promise<WakeLockSentinel>((resolve) => grants.push(resolve));
  const grant = () => {
    const s = new FakeSentinel();
    grants.shift()!(s as unknown as WakeLockSentinel);
    return s;
  };
  return { request, grant, count: () => grants.length };
}

describe('WakeLockHolder', () => {
  it('releases a lock that is granted after it stopped being wanted', async () => {
    let wanted = true;
    const r = deferredRequests();
    const lock = new WakeLockHolder(() => wanted, r.request);
    const pending = lock.sync();
    wanted = false; // e.g. the recording stopped while the request was pending
    await lock.sync();
    const s = r.grant();
    await pending;
    expect(s.released).toBe(true);
    expect(lock.held).toBe(false);
  });

  it('keeps a granted lock, asks only once at a time, and releases it when no longer wanted', async () => {
    let wanted = true;
    const r = deferredRequests();
    const lock = new WakeLockHolder(() => wanted, r.request);
    const pending = lock.sync();
    void lock.sync(); // e.g. a visibility change while the first request is pending
    expect(r.count()).toBe(1);
    const s = r.grant();
    await pending;
    expect(lock.held).toBe(true);
    wanted = false;
    await lock.sync();
    expect(s.released).toBe(true);
    expect(lock.held).toBe(false);
  });

  it('forgets a lock the browser released (page hidden) so it can be taken again', async () => {
    const r = deferredRequests();
    const lock = new WakeLockHolder(() => true, r.request);
    const first = lock.sync();
    const s = r.grant();
    await first;
    await s.release(); // the browser does this when the page is hidden
    expect(lock.held).toBe(false);
    const again = lock.sync();
    r.grant();
    await again;
    expect(lock.held).toBe(true);
  });
});
