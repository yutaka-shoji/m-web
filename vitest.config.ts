import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
      // Local-time formatting (CSV datetime) is tested against a fixed zone.
      env: { TZ: 'Asia/Tokyo' },
    },
  }),
);
