import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import makeManifestPlugin from './utils/plugins/make-manifest-plugin.js';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(rootDir, 'src');

const outDir = resolve(rootDir, 'dist');
export default defineConfig({
  resolve: {
    alias: {
      '@root': rootDir,
      '@src': srcDir,
      '@assets': resolve(srcDir, 'assets'),
    },
  },
  plugins: [
    makeManifestPlugin({ outDir }),
  ],
  publicDir: false,
  build: {
    rollupOptions: {
      input: {
        background: resolve(srcDir, 'background', 'index.ts'),
        'content/bale': resolve(srcDir, 'content', 'bale.ts'),
        'injected/bale-webrtc-hook': resolve(srcDir, 'injected', 'bale-webrtc-hook.ts'),
        popup: resolve(srcDir, 'popup', 'index.html'),
        'offscreen/peer-link-host': resolve(srcDir, 'offscreen', 'peer-link-host.html'),
      },
      external: ['chrome'],
      output: {
        entryFileNames: (chunk: { name: string }) => {
          // Keep stable names for manifest references
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'content/bale') return 'content/bale.js';
          if (chunk.name === 'injected/bale-webrtc-hook') return 'injected/bale-webrtc-hook.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
  },
});
