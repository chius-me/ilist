import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) {
            return 'vendor-react';
          }
          if (id.includes('/node_modules/lucide-react/')) {
            return 'vendor-icons';
          }
          if (id.includes('/node_modules/pdfjs-dist/')) {
            return 'vendor-pdf';
          }
          if (id.includes('/node_modules/highlight.js/')) {
            return 'vendor-highlight';
          }
          if (id.includes('/node_modules/marked/')) {
            return 'vendor-markdown';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/file/': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/s/': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        bypass(req) {
          if (req.headers.accept?.includes('text/html')) return req.url;
        },
      },
    },
  },
});
