<script setup lang="ts">
defineProps<{ tone?: 'warn' | 'info' }>();
</script>

<template>
  <div class="banner" :class="`banner--${tone ?? 'info'}`" :role="tone === 'warn' ? 'alert' : 'status'">
    <span class="banner__mark" aria-hidden="true" />
    <div class="banner__body"><slot /></div>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius);
  background: var(--c-fill);
  font-size: var(--fs-m);
  line-height: 1.6;
}
.banner__mark {
  width: 3px;
  align-self: stretch;
  border-radius: 2px;
  background: var(--c-line-strong);
  flex: none;
}
.banner--warn {
  background: var(--c-warn-weak);
}
.banner--warn .banner__mark {
  background: var(--c-warn);
}
.banner__body :deep(a) {
  font-weight: 500;
}
</style>
