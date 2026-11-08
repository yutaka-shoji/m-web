<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MLOGGER_NAME_PREFIX } from '../../../core/ble/constants';
import { t } from '../../i18n';
import type { DeviceEntry } from '../../stores/devices';

const props = defineProps<{ entry: DeviceEntry; online: boolean }>();
const current = computed(() => props.entry.state.value.meta.name ?? '');
const name = ref(current.value);
watch(current, (v) => (name.value = v));
const busy = ref(false);
const msg = ref<{ ok: boolean; text: string } | null>(null);

/** The firmware limits the raw JSON string token (escapes included) to 20 bytes. */
const bytes = computed(() => new TextEncoder().encode(JSON.stringify(name.value)).length - 2);
const valid = computed(() => name.value.trim().length > 0 && bytes.value <= 20);

async function apply() {
  if (!valid.value || name.value === current.value) return;
  busy.value = true;
  msg.value = null;
  try {
    await props.entry.controller.rename(name.value);
    msg.value = { ok: true, text: `${t('drawer.renamed')} — ${t('drawer.renameRestart')}` };
  } catch (e) {
    msg.value = { ok: false, text: t('error.commandFailed', { message: e instanceof Error ? e.message : String(e) }) };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="sec">
    <h3 class="sec__title">{{ t('drawer.rename') }}</h3>
    <div class="row">
      <input v-model="name" type="text" class="grow" maxlength="20" :disabled="!online" />
      <span class="num" :class="bytes > 20 ? 'warn' : 'muted'">{{ t('drawer.renameBytes', { n: bytes }) }}</span>
      <button class="btn btn--small" :disabled="!online || busy || !valid || name === current" @click="apply">
        {{ t('drawer.renameApply') }}
      </button>
    </div>
    <p v-if="bytes > 20" class="msg warn">{{ t('drawer.renameTooLong') }}</p>
    <p v-else-if="!name.startsWith(MLOGGER_NAME_PREFIX)" class="msg muted">{{ t('drawer.renamePrefix') }}</p>
    <p v-if="msg" class="msg" :class="msg.ok ? 'ok' : 'warn'" role="status">{{ msg.text }}</p>
  </section>
</template>

<style scoped src="./drawer.css"></style>
