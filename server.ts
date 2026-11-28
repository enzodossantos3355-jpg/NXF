import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createApiRouter } from './server/routes.ts';
import { startBrawlStarsScheduler } from './server/brawlStarsService.ts';
import { startMatchTrackerScheduler } from './server/matchTrackerService.ts';
import { startNewsScheduler } from './server/newsSchedulerService.ts';

function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
    origins.add('http://localhost:5173');
  }

  const rawList = [
    process.env.ALLOWED_ORIGINS,
    process.env.APP_URL,
    process.env.VITE_APP_URL,
    process.env.FRONTEND_ORIGIN,
  ]
    .filter(Boolean)
    .join(',');

  rawList
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .forEach((origin) => origins.add(origin));

  return origins;
}

export function createApp() {
  const app = express();
  const allowedOrigins = buildAllowedOrigins();

  app.set('trust proxy', 1);

  // Security headers + controlled CORS for Render Static Site -> Render Starter API
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin?.replace(/\/+$/, '');
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.use('/api', createApiRouter());

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Endpoint da API não encontrado.' });
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(indexHtml);
      });
    } else {
      app.get('/', (_req: Request, res: Response) => {
        res.json({
          ok: true,
          service: 'nxf-esports-api',
          mode: 'render-starter-backend',
        });
      });
    }
  }

  startBrawlStarsScheduler();
  startMatchTrackerScheduler();
  startNewsScheduler();

  app.listen(port, '0.0.0.0', () => {
    console.log(`[NXF Backend] Servidor escutando na porta ${port} (${isProd ? 'produção' : 'desenvolvimento'}).`);
  });
}

const isEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isEntryPoint) {
  startServer().catch((err) => {
    console.error('[NXF Backend] Erro fatal ao iniciar servidor:', err);
    process.exit(1);
  });
}
