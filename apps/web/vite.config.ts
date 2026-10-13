import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // O front fala com /api; em dev o Vite encaminha ao backend (sem CORS, mesma origem).
    proxy: { '/api': 'http://localhost:3333', '/health': 'http://localhost:3333', '/ready': 'http://localhost:3333' },
  },
});
