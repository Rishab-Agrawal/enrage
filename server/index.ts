// The deployed game: the built page and its API.
import express from 'express';
import helmet from 'helmet';
import { api } from './api.ts';
import { alert, tell } from './telegram.ts';

process.on('uncaughtException', (error) => void alert('The server crashed', error.message).finally(() => process.exit(1)));

express()
  .use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Speech streams to Deepgram; the models' textures are fetched as blobs.
          connectSrc: ["'self'", 'blob:', 'wss://api.deepgram.com'],
          imgSrc: ["'self'", 'data:', 'blob:'],
        },
      },
    }),
  )
  .use(api)
  .use(express.static('dist'))
  .listen(Number(process.env.PORT ?? 3000), (error) => {
    if (error) throw error;
    void tell('🟢 enrage is up.');
  });
