import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { platform } from 'node:process';
import { pathToFileURL } from 'node:url';
import type { PluginOption } from 'vite';

const here = resolve(new URL('.', import.meta.url).pathname);
const manifestFile = resolve(here, '..', '..', 'manifest.js');
const refreshFilePath = resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'hmr',
  'dist',
  'lib',
  'injections',
  'refresh.js',
);

const withHMRId = (code: string) => `(function() {let __HMR_ID = 'chrome-extension-hmr';${code}\n})();`;

const getManifestWithCacheBurst = async () => {
  const withCacheBurst = (path: string) => `${path}?${Date.now().toString()}`;

  /**
   * In Windows, import() doesn't work without file:// protocol.
   * So, we need to convert path to file:// protocol. (url.pathToFileURL)
   */
  if (platform === 'win32') {
    return (await import(withCacheBurst(pathToFileURL(manifestFile).href))).default;
  } else {
    return (await import(withCacheBurst(manifestFile))).default;
  }
};

export default (config: { outDir: string }): PluginOption => {
  const makeManifest = (manifest: any, to: string) => {
    if (!existsSync(to)) {
      mkdirSync(to);
    }

    const manifestPath = resolve(to, 'manifest.json');

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  };

  return {
    name: 'make-manifest',
    buildStart() {
      this.addWatchFile(manifestFile);
    },
    async writeBundle() {
      const outDir = config.outDir;
      const manifest = await getManifestWithCacheBurst();
      makeManifest(manifest, outDir);
    },
  };
};
