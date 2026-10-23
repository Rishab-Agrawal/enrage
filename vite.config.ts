import { json } from 'node:stream/consumers';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { judge, Turn } from './server/judge.ts';

/**
 * The game's server side, keeping API keys from the browser.
 * ponytail: dev server only; the production server takes it over when the game deploys.
 */
function api(): Plugin {
  return {
    name: 'api',
    configureServer(server) {
      // Deepgram, Jev and LangSmith read their keys from the environment.
      Object.assign(process.env, loadEnv(server.config.mode, process.cwd(), ''));
      // A 30 s Deepgram token.
      server.middlewares.use('/api/stt-token', (_request, response, next) => {
        fetch('https://api.deepgram.com/v1/auth/grant', { method: 'POST', headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } })
          .then(async (grant) => {
            response.statusCode = grant.status;
            response.setHeader('Content-Type', 'application/json');
            response.end(await grant.text());
          })
          .catch(next);
      });
      // Whether her newest line turns Gorran's mood.
      server.middlewares.use('/api/judge', async (request, response, next) => {
        const turn = Turn.safeParse(await json(request).catch(() => null));
        if (!turn.success) {
          response.statusCode = 400;
          response.end();
          return;
        }
        judge(turn.data)
          .then((turns) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ turns }));
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [api()],
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
});
