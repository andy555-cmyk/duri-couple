/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages serves the app under /duri-couple/, so every asset path stays relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2020', sourcemap: false },
  server: { port: 5175 },
  test: { environment: 'node' },
});
