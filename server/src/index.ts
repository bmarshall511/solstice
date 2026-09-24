// Local development server: the same app as production, plus the built web app from web/dist.
import express from 'express';
import { existsSync } from 'node:fs';
import { app } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const dist = new URL('../../web/dist/', import.meta.url).pathname;
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|auth).*/, (_req, res) => res.sendFile(dist + 'index.html'));
}
app.listen(port, '127.0.0.1', () => console.log(`Solstice on http://localhost:${port}`));
