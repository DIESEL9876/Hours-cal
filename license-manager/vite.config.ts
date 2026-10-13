import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
/** src/ui/components.tsx imports '../engine' for one helper; use a tiny stub instead of the payroll engine. */
function stubEngine(): Plugin {
  const stub = fileURLToPath(new URL('./src/engineStub.ts', import.meta.url));
  return {
    name: 'lm-stub-engine',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '../engine' && importer && /[\\/]src[\\/]ui[\\/]components\.tsx$/.test(importer)) return stub;
      return null;
    },
  };
}

const conf = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { version: string };

// Separate Vite root for the owner-only License Manager (never bundled into Hours-Cal).
export default defineConfig({
  root,
  plugins: [stubEngine(), react(), tailwindcss()],
  define: { __LM_VERSION__: JSON.stringify(conf.version) },
  clearScreen: false,
  base: './',
  server: { port: 1430, strictPort: true, fs: { allow: ['..'] } },
  preview: { port: 4183, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
