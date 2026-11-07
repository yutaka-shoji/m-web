<script setup lang="ts">
defineProps<{
  label: string;
  tone: 'accent' | 'warn' | 'muted';
  pulse?: boolean;
  detail?: string | undefined;
}>();
</script>

<template>
  <span class="chip" :class="`chip--${tone}`" role="status">
    <span class="chip__dot" :class="{ 'is-pulsing': pulse }" aria-hidden="true" />
    <span class="chip__label">{{ label }}</span>
    <span v-if="detail" class="chip__detail">{{ detail }}</span>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-s);
  line-height: 1.2;
  white-space: nowrap;
  color: var(--c-fg-muted);
}
.chip__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-line-strong);
  flex: none;
}
.chip--accent {
  color: var(--c-accent);
}
.chip--accent .chip__dot {
  background: var(--c-accent);
}
.chip--warn {
  color: var(--c-warn);
}
.chip--warn .chip__dot {
  background: var(--c-warn);
}
.chip__detail {
  color: var(--c-fg-subtle);
}
.is-pulsing {
  animation: pulse 1.6s var(--ease) infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
</style>
