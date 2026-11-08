import { createRouter, createWebHashHistory } from 'vue-router';
import DashboardView from './app/views/DashboardView.vue';

// Hash history: navigating between views never reloads the document, so open
// Bluetooth connections survive. It also needs no server-side rewrites on GitHub Pages.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/data', name: 'data', component: () => import('./app/views/DataView.vue') },
    { path: '/guide/:section?', name: 'guide', component: () => import('./app/views/GuideView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./app/views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(to, from, saved) {
    if (saved) return saved;
    // GuideView scrolls to a section once its heading has rendered; scrolling to the
    // top here (which runs after it) would undo that.
    if (to.name === 'guide' && to.params.section) return false;
    if (to.path !== from.path) return { top: 0 };
    return undefined;
  },
});
