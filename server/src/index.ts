// Local development server: the same app as production, plus the built web app from web/dist.
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));   // not .pathname: the folder name's space would arrive as %20 (web/vite.config.js does the same)
// Same order as production: the built files first (Vercel's CDN there), and only /api and /auth reach the app, whose first step
// is the database. So a database outage answers on the API and the page still loads to say so.
const local = express();
if (existsSync(dist)) local.use(express.static(dist));
local.use((req, res, next) => /^\/(api|auth)(\/|$)/.test(req.path) ? app(req, res, next) : next());
if (existsSync(dist)) local.get(/^\/(?!api|auth).*/, (_req, res) => res.sendFile(dist + 'index.html'));
local.listen(port, '127.0.0.1', () => console.log(`Solstice on http://localhost:${port}`));
