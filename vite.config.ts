import { defineConfig, loadEnv } from 'vite';
import { api } from './server/api.ts';

export default defineConfig({
  plugins: [
    {
      name: 'api',
      configureServer(server) {
        // Deepgram, Jev and LangSmith read their keys from the environment.
        Object.assign(process.env, loadEnv(server.config.mode, process.cwd(), ''));
        server.middlewares.use(api);
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
