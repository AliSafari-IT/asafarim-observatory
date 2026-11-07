import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const proxy = {
  '/api': 'http://127.0.0.1:8080',
  '/healthz': 'http://127.0.0.1:8080'
};

export default defineConfig({
  plugins: [sveltekit({ adapter: adapter(), preprocess: vitePreprocess() })],
  server: { proxy, port: 5173, strictPort: true },
  preview: { proxy, port: 4173, strictPort: true }
});
