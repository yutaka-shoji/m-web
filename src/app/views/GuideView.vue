<script setup lang="ts">
import { defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { locale } from '../i18n';
import '../styles/prose.css';

// One chunk per language; only the active one is downloaded.
const GuideJa = defineAsyncComponent(() => import('../../guide/ja.md'));
const GuideEn = defineAsyncComponent(() => import('../../guide/en.md'));

const route = useRoute();
const content = ref<HTMLElement>();
const toc = ref<Array<{ id: string; text: string }>>([]);

function collect(): void {
  const root = content.value;
  if (!root) return;
  toc.value = [...root.querySelectorAll('h2[id]')].map((h) => ({ id: h.id, text: h.textContent ?? '' }));
}

function scrollToSection(): void {
  const id = typeof route.params.section === 'string' ? route.params.section : '';
  if (!id) return;
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

// The async component renders after mount; observe the content for headings.
let observer: MutationObserver | null = null;
onMounted(() => {
  observer = new MutationObserver(() => {
    collect();
    scrollToSection();
  });
  if (content.value) observer.observe(content.value, { childList: true, subtree: true });
});
watch(
  () => route.params.section,
  () => void nextTick(scrollToSection),
);
watch(locale, () => (toc.value = []));
</script>

<template>
  <section class="page guide">
    <nav v-if="toc.length" class="toc" aria-label="Contents">
      <ol>
        <li v-for="h in toc" :key="h.id">
          <RouterLink :to="`/guide/${h.id}`" :class="{ 'is-active': route.params.section === h.id }">{{ h.text }}</RouterLink>
        </li>
      </ol>
    </nav>
    <article ref="content" class="guide__body">
      <GuideJa v-if="locale === 'ja'" />
      <GuideEn v-else />
    </article>
  </section>
</template>

<style scoped>
.guide {
  display: grid;
  grid-template-columns: 220px minmax(0, 760px);
  gap: var(--sp-7);
  align-items: start;
}
.toc {
  position: sticky;
  top: calc(var(--header-h) + var(--sp-5));
  max-height: calc(100vh - var(--header-h) - var(--sp-6));
  overflow-y: auto;
  font-size: var(--fs-s);
}
.toc ol {
  margin: 0;
  padding: 0;
  list-style: none;
  border-left: 1px solid var(--c-line);
}
.toc a {
  display: block;
  margin-left: -1px;
  padding: 4px 0 4px var(--sp-3);
  border-left: 1px solid transparent;
  color: var(--c-fg-muted);
  text-decoration: none;
}
.toc a:hover {
  color: var(--c-fg);
}
.toc a.is-active {
  border-left-color: var(--c-fg);
  color: var(--c-fg);
}
@media (max-width: 960px) {
  .guide {
    grid-template-columns: minmax(0, 1fr);
  }
  .toc {
    position: static;
    max-height: none;
  }
}
</style>
