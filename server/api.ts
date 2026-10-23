import express, { type NextFunction, type Request, type Response } from 'express';
import { DAY, ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { judge, Turn } from './judge.ts';
import { alert, tell } from './telegram.ts';

/** The game's server side, keeping API keys from the browser: the dev server mounts it, and `index.ts` serves it deployed. */
export const api = express().disable('x-powered-by');

// Every route spends an API key: each player gets a ration, and all of them a daily budget, which caps what bots can spend.
api.use(
  '/api',
  rateLimit({
    // A turn at the mic is two requests, a token and a verdict: this allows one every 6 s.
    limit: 20,
    // Railway's edge sets X-Real-IP to the player's address; the dev server has no edge.
    keyGenerator: (request) => ipKeyGenerator(request.get('x-real-ip') ?? request.ip ?? ''),
    validate: { xForwardedForHeader: false },
    handler: (_request, response) => {
      void alert('A player hit the rate limit: a bot?');
      response.sendStatus(429);
    },
  }),
  rateLimit({
    windowMs: DAY,
    limit: 4000,
    keyGenerator: () => 'everyone',
    handler: (_request, response) => {
      void alert('The daily budget is spent: Gorran ignores everyone until it renews');
      response.sendStatus(429);
    },
  }),
);

// A 30 s Deepgram token.
api.get('/api/stt-token', async (_request, response) => {
  const grant = await fetch('https://api.deepgram.com/v1/auth/grant', { method: 'POST', headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
  if (!grant.ok) void alert('Deepgram refuses tokens', `HTTP ${grant.status}`);
  response.status(grant.status).type('json').send(await grant.text());
});

// A player left the title screen for the fight.
api.post('/api/play', (_request, response) => {
  void tell('🎮 Someone started playing.');
  response.sendStatus(204);
});

// Whether her newest line turns Gorran's mood. Only JSON is parsed: another site can't send that without CORS, which this API doesn't allow.
api.post('/api/judge', express.json(), async (request, response) => {
  const turn = Turn.safeParse(request.body);
  if (!turn.success) {
    response.sendStatus(400);
    return;
  }
  response.json({ turns: await judge(turn.data) });
});

api.use((error: Error & { status?: number }, request: Request, response: Response, _next: NextFunction) => {
  const status = error.status ?? 500;
  if (status >= 500) void alert(`${request.path} is failing`, error.message);
  response.sendStatus(status);
});
