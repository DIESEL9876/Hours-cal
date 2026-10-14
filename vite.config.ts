/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Offline OCR assets (Tesseract worker, WebAssembly cores, Hebrew + English language data) are served
 * from the app itself under /ocr — nothing is downloaded at runtime.
 */
const nm = (p: string) => fileURLToPath(new URL(`./node_modules/${p}`, import.meta.url));
const OCR_ASSETS: Record<string, string> = {
  'ocr/worker.min.js': nm('tesseract.js/dist/worker.min.js'),
  'ocr/core/tesseract-core-lstm.wasm.js': nm('tesseract.js-core/tesseract-core-lstm.wasm.js'),
  'ocr/core/tesseract-core-simd-lstm.wasm.js': nm('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'),
  'ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js': nm('tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'),
  'ocr/lang/heb.traineddata.gz': nm('@tesseract.js-data/heb/4.0.0_best_int/heb.traineddata.gz'),
  'ocr/lang/eng.traineddata.gz': nm('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
};
function ocrAssets(): Plugin {
  return {
    name: 'hourscal-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const key = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '');
        const file = OCR_ASSETS[key];
        if (!file || !existsSync(file)) return next();
        res.setHeader('Content-Type', key.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(OCR_ASSETS)) this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
    },
  };
}

// Tauri expects a fixed port in dev and relative asset paths in production.
export default defineConfig({
  plugins: [react(), tailwindcss(), ocrAssets()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  base: './',
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2000 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'license-manager/src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
