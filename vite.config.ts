import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * `/api/stt-token`: a 30 s Deepgram token, so the browser never sees the API key.
 * ponytail: dev server only; the production server takes it over when the game deploys.
 */
function sttToken(key: string): Plugin {
  return {
    name: 'stt-token',
    configureServer(server) {
      server.middlewares.use('/api/stt-token', (_request, response, next) => {
        fetch('https://api.deepgram.com/v1/auth/grant', { method: 'POST', headers: { Authorization: `Token ${key}` } })
          .then(async (grant) => {
            response.statusCode = grant.status;
            response.setHeader('Content-Type', 'application/json');
            response.end(await grant.text());
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [sttToken(loadEnv(mode, process.cwd(), '').DEEPGRAM_API_KEY)],
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
}));
