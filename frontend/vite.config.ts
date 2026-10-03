import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs separately; proxy /api so the browser sees one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' },
  },
});
