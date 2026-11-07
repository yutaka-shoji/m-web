<script setup lang="ts">
import { locale, setLocale, t } from '../../i18n';
</script>

<template>
  <header class="header">
    <div class="header__inner">
      <RouterLink to="/" class="brand">
        <span class="brand__name">{{ t('app.name') }}</span>
        <span class="brand__tagline">{{ t('app.tagline') }}</span>
      </RouterLink>

      <nav class="nav" :aria-label="t('nav.main')">
        <RouterLink to="/" class="nav__link" exact-active-class="is-active">{{ t('nav.dashboard') }}</RouterLink>
        <RouterLink to="/data" class="nav__link" active-class="is-active">{{ t('nav.data') }}</RouterLink>
        <RouterLink to="/guide" class="nav__link" active-class="is-active">{{ t('nav.guide') }}</RouterLink>
      </nav>

      <div class="tools">
        <div class="lang" role="group" :aria-label="t('lang.label')">
          <button
            type="button"
            class="lang__btn"
            :aria-pressed="locale === 'ja'"
            :class="{ 'is-active': locale === 'ja' }"
            @click="setLocale('ja')"
          >
            JA
          </button>
          <span class="lang__sep" aria-hidden="true">/</span>
          <button
            type="button"
            class="lang__btn"
            :aria-pressed="locale === 'en'"
            :class="{ 'is-active': locale === 'en' }"
            @click="setLocale('en')"
          >
            EN
          </button>
        </div>
        <RouterLink to="/settings" class="nav__link" active-class="is-active">{{ t('nav.settings') }}</RouterLink>
      </div>
    </div>
  </header>
</template>

<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 20;
  background: color-mix(in srgb, var(--c-bg) 92%, transparent);
  backdrop-filter: saturate(1.2) blur(8px);
  border-bottom: 1px solid var(--c-line);
}
.header__inner {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  max-width: var(--page-max);
  height: var(--header-h);
  margin: 0 auto;
  padding: 0 var(--page-gutter);
}
.brand {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  text-decoration: none;
}
.brand__name {
  font-weight: 650;
  letter-spacing: 0.02em;
}
.brand__tagline {
  color: var(--c-fg-subtle);
  font-size: var(--fs-s);
}
.nav {
  display: flex;
  gap: var(--sp-5);
}
.nav__link {
  position: relative;
  color: var(--c-fg-muted);
  font-size: var(--fs-m);
  text-decoration: none;
  padding: var(--sp-2) 0;
}
.nav__link:hover {
  color: var(--c-fg);
}
.nav__link.is-active {
  color: var(--c-fg);
}
.nav__link.is-active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1.5px;
  background: var(--c-fg);
}
.tools {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  margin-left: auto;
}
.lang {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: var(--fs-s);
}
.lang__btn {
  padding: 2px 4px;
  border: 0;
  background: none;
  color: var(--c-fg-subtle);
  cursor: pointer;
  letter-spacing: 0.04em;
}
.lang__btn.is-active {
  color: var(--c-fg);
  font-weight: 600;
}
.lang__sep {
  color: var(--c-line-strong);
}
@media (max-width: 720px) {
  .brand__tagline {
    display: none;
  }
  .header__inner {
    gap: var(--sp-4);
  }
  .nav {
    gap: var(--sp-3);
  }
}
</style>
