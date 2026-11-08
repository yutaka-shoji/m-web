import { onScopeDispose, readonly, ref, type Ref } from 'vue';

// One shared 1 Hz clock for relative-time labels; started on first use, stopped when unused.
const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(): Readonly<Ref<number>> {
  users += 1;
  if (!timer) {
    now.value = Date.now();
    timer = setInterval(() => (now.value = Date.now()), 1000);
  }
  onScopeDispose(() => {
    users -= 1;
    if (users === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  return readonly(now);
}
