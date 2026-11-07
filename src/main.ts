import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './app/styles/tokens.css';
import './app/styles/base.css';

createApp(App).use(createPinia()).use(router).mount('#app');
