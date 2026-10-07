// Local development server: the same app as production, plus the built web app from web/dist.
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));   // not .pathname: the folder name's space would arrive as %20 (web/vite.config.js does the same)
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|auth).*/, (_req, res) => res.sendFile(dist + 'index.html'));
}
app.listen(port, '127.0.0.1', () => console.log(`Solstice on http://localhost:${port}`));
