import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Ścieżki relatywne — w wersji spakowanej Electron ładuje pliki przez file://
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        // Interfejs aplikacji (ładowany przez Electron z file://)
        main: resolve(__dirname, 'index.html'),
        // Strona skanera dla telefonu (serwowana po sieci przez electron/bridge.js)
        mobile: resolve(__dirname, 'mobile.html'),
      },
    },
  },
});
