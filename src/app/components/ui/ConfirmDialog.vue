<script setup lang="ts">
import { ref, watch } from 'vue';
import { t } from '../../i18n';

const props = defineProps<{
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  confirmDisabled?: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dlg = ref<HTMLDialogElement>();

watch(
  () => props.open,
  (open) => {
    const d = dlg.value;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  },
  { flush: 'post' },
);
</script>

<template>
  <dialog ref="dlg" class="dialog" @cancel.prevent="emit('cancel')" @close="open && emit('cancel')">
    <form method="dialog" class="dialog__form" @submit.prevent="!confirmDisabled && emit('confirm')">
      <h2 class="dialog__title">{{ title }}</h2>
      <p v-if="body" class="dialog__body">{{ body }}</p>
      <div class="dialog__extra"><slot /></div>
      <div class="dialog__actions">
        <button type="button" class="btn btn--quiet" @click="emit('cancel')">{{ t('common.cancel') }}</button>
        <button
          type="submit"
          class="btn"
          :class="danger ? 'btn--danger-solid' : 'btn--primary'"
          :disabled="confirmDisabled"
          autofocus
        >
          {{ confirmLabel }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.dialog {
  width: min(440px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid var(--c-line);
  border-radius: calc(var(--radius) + 2px);
  background: var(--c-bg);
  color: var(--c-fg);
  box-shadow: 0 12px 40px rgb(0 0 0 / 14%);
}
.dialog::backdrop {
  background: var(--c-overlay);
}
.dialog__form {
  display: grid;
  gap: var(--sp-4);
  padding: var(--sp-5);
}
.dialog__title {
  font-size: var(--fs-l);
  font-weight: 600;
}
.dialog__body {
  color: var(--c-fg-muted);
}
.dialog__extra:empty {
  display: none;
}
.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
</style>
