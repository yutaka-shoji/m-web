import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Markdown from 'unplugin-vue-markdown/vite';

/**
 * Guide Markdown: slug ids on headings (sections are addressed as #/guide/<id>), and external
 * links open in a new tab — leaving this page would drop every Bluetooth connection.
 */
function guideMarkdown(md: { core: { ruler: { push(name: string, fn: (state: { tokens: Token[] }) => void): void } } }) {
  md.core.ruler.push('guide_links', (state) => {
    for (const tok of state.tokens) {
      for (const child of tok.children ?? []) {
        if (child.type !== 'link_open') continue;
        const href = child.attrGet('href') ?? '';
        if (/^https?:/.test(href)) {
          child.attrSet('target', '_blank');
          child.attrSet('rel', 'noopener');
        }
      }
    }
  });
  md.core.ruler.push('heading_ids', (state) => {
    const seen = new Map<string, number>();
    state.tokens.forEach((tok, i) => {
      if (tok.type !== 'heading_open') return;
      const text = state.tokens[i + 1]?.content ?? '';
      let slug = text
        .trim()
        .toLowerCase()
        .replace(/[\s　]+/g, '-')
        .replace(/[^\p{L}\p{N}-]/gu, '');
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      if (n) slug += `-${n}`;
      tok.attrSet('id', slug);
    });
  });
}
interface Token {
  type: string;
  content: string;
  children?: Token[] | null;
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}

// Relative base: works on GitHub Pages (/m-web/) and any other sub-path,
// because routing is hash-based and all asset URLs are emitted relative.
export default defineConfig({
  base: './',
  plugins: [
    vue({ include: [/\.vue$/, /\.md$/] }),
    Markdown({
      markdownSetup: (md) => {
        guideMarkdown(md as unknown as Parameters<typeof guideMarkdown>[0]);
      },
      wrapperClasses: 'prose',
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    manifest: true,
  },
  worker: {
    format: 'es',
  },
});
