import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  CHALLENGE_TARGETS,
  parseDecInput,
  parseRaInput,
  querySpherexObservations,
  resolveTargetName,
} from './server/spherexArchive.ts';
import {
  buildSingleImageFits,
  computeFitsDifference,
  FitsValidationError,
  inspectAndRenderFits,
} from './server/fitsProcessor.ts';
import { handleHipsProxyRequest } from './server/hipsProxy.ts';
import type { FeaturedObservation } from './src/types/spherex.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

let featuredCache: {
  utcDateKey: string;
  cachedAt: number;
  isCubeFallback: boolean;
  items: FeaturedObservation[];
  allNewestObsByTarget: Array<{ targetName: string; category: string; summary: string; observations: import('./src/types/spherex.ts').SpherexObservation[] }>;
  isFallback: boolean;
} | null = null;

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function toUserLocalDateKey(isoUtc: string, tzOffsetMin: number): string | null {
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) return null;
  // JS getTimezoneOffset() returns (UTC - local) in minutes, so local = UTC - tzOffsetMin
  const shifted = new Date(ms - tzOffsetMin * 60_000);
  return shifted.toISOString().slice(0, 10);
}

async function buildFeaturedGallery(
  localDate?: string,
  tzOffsetMin = 0
): Promise<{
  dateKey: string;
  localDate: string;
  matchedLocalDate: boolean;
  featuredIndex: number;
  items: FeaturedObservation[];
  isFallback: boolean;
}> {
  const utcDateKey = getUtcDateKey();
  const effectiveLocalDate =
    localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate) ? localDate : utcDateKey;

  let baseItems: FeaturedObservation[] = [];
  let targetObsPools: Array<{
    targetName: string;
    category: string;
    summary: string;
    observations: import('./src/types/spherex.ts').SpherexObservation[];
  }> = [];

  const cacheFresh =
    featuredCache &&
    featuredCache.utcDateKey === utcDateKey &&
    featuredCache.items.length > 0 &&
    (!featuredCache.isCubeFallback || Date.now() - featuredCache.cachedAt < 3 * 60 * 1000);

  if (cacheFresh && featuredCache) {
    baseItems = [...featuredCache.items];
    targetObsPools = featuredCache.allNewestObsByTarget;
  } else {
    const items: FeaturedObservation[] = [];
    let usedCubeFallback = false;

    await Promise.all(
      CHALLENGE_TARGETS.map(async (target) => {
        try {
          const res = await querySpherexObservations({
            raDeg: target.raDeg,
            decDeg: target.decDeg,
            radiusDeg: 0.05,
            collection: 'spherex_dr1',
            resolvedName: target.name,
          });
          if (res.sourceStatus === 'live-cube-fallback') {
            usedCubeFallback = true;
          }
          if (res.observations.length > 0) {
            // Observations are sorted ascending by tMinMjd; reverse to inspect newest epochs first
            const newestFirst = [...res.observations].reverse();
            targetObsPools.push({
              targetName: target.name,
              category: target.category,
              summary: target.summary,
              observations: newestFirst,
            });

            const preferred =
              newestFirst.find((o) => o.detectorNumber === 4) ||
              newestFirst.find((o) => o.detectorNumber === 3) ||
              newestFirst[0];

            const inspected = await inspectAndRenderFits({
              accessUrl: preferred.accessUrl,
              raDeg: target.raDeg,
              decDeg: target.decDeg,
              sizeDeg: 0.08,
              stretch: 'asinh',
              subtractZodi: true,
              colormap: 'infrared',
            });

            items.push({
              id: `${target.id}-${preferred.obsId}`,
              title: target.name,
              regionLabel: `${target.category} · ${preferred.raHms}, ${preferred.decDms}`,
              scientificContext: target.summary,
              isDemonstrationFallback: false,
              observation: preferred,
              previewImageUrl: inspected.pngDataUrl,
              headers: inspected.headers,
              photometry: inspected.photometry,
            });
          }
        } catch {
          // Individual target fetch failures are tolerated; handled below if all fail
        }
      })
    );

    baseItems = [...items].sort((a, b) => b.observation.tMinMjd - a.observation.tMinMjd);
    if (baseItems.length > 0) {
      featuredCache = {
        utcDateKey,
        cachedAt: Date.now(),
        isCubeFallback: usedCubeFallback,
        items: baseItems,
        allNewestObsByTarget: targetObsPools,
        isFallback: false,
      };
    }
  }

  if (baseItems.length > 0) {
    // 1. Check if any already-rendered item matches the user's local calendar day
    const directMatchIdx = baseItems.findIndex(
      (it) => toUserLocalDateKey(it.observation.obsDateIso, tzOffsetMin) === effectiveLocalDate
    );
    if (directMatchIdx !== -1) {
      return {
        dateKey: effectiveLocalDate,
        localDate: effectiveLocalDate,
        matchedLocalDate: true,
        featuredIndex: directMatchIdx,
        items: baseItems,
        isFallback: false,
      };
    }

    // 2. Check all observations in target pools for a capture on the user's local day
    for (const pool of targetObsPools) {
      const match =
        pool.observations.find(
          (o) =>
            o.detectorNumber === 4 &&
            toUserLocalDateKey(o.obsDateIso, tzOffsetMin) === effectiveLocalDate
        ) ||
        pool.observations.find(
          (o) => toUserLocalDateKey(o.obsDateIso, tzOffsetMin) === effectiveLocalDate
        );

      if (match) {
        try {
          const inspected = await inspectAndRenderFits({
            accessUrl: match.accessUrl,
            raDeg: match.raDeg,
            decDeg: match.decDeg,
            sizeDeg: 0.08,
            stretch: 'asinh',
            subtractZodi: true,
            colormap: 'infrared',
          });
          const todayItem: FeaturedObservation = {
            id: `today-${match.obsId}`,
            title: pool.targetName,
            regionLabel: `${pool.category} · ${match.raHms}, ${match.decDms}`,
            scientificContext: pool.summary,
            isDemonstrationFallback: false,
            observation: match,
            previewImageUrl: inspected.pngDataUrl,
            headers: inspected.headers,
            photometry: inspected.photometry,
          };
          return {
            dateKey: effectiveLocalDate,
            localDate: effectiveLocalDate,
            matchedLocalDate: true,
            featuredIndex: 0,
            items: [todayItem, ...baseItems],
            isFallback: false,
          };
        } catch {
          // If rendering that specific exposure fails, continue searching or fall back to latest
        }
      }
    }

    // 3. No observation captured on user's local day -> always show the LATEST observation available (index 0)
    return {
      dateKey: effectiveLocalDate,
      localDate: effectiveLocalDate,
      matchedLocalDate: false,
      featuredIndex: 0,
      items: baseItems,
      isFallback: false,
    };
  }

  // Clearly-labeled demonstration fallback only if live IRSA failed
  const fallbackItem: FeaturedObservation = {
    id: 'demo-fallback-wise0855',
    title: 'WISE 0855 (Demonstration Fallback)',
    regionLabel: 'Demonstration Plate · Archive Temporarily Unreachable',
    scientificContext:
      'Live NASA/IPAC IRSA connection could not be completed at this moment. This clearly labeled demonstration plate illustrates a typical near-infrared survey field until archive access resumes.',
    isDemonstrationFallback: true,
    observation: {
      id: 'demo-fallback',
      obsId: 'DEMO-FALLBACK',
      publisherDid: 'Not available (demonstration fallback)',
      collection: 'demonstration_fallback',
      bandpassName: 'SPHEREx-D4 (Reference)',
      detectorNumber: 4,
      emMinUm: 2.42,
      emMaxUm: 3.82,
      emCenterUm: 3.12,
      emResPower: 35,
      raDeg: 133.795129,
      decDeg: -7.245147,
      raHms: '08h55m10.831s',
      decDms: '-07d14m42.53s',
      tMinMjd: 0,
      tMaxMjd: 0,
      obsDateIso: 'Not available',
      obsDateDisplay: 'Demonstration Plate (No live capture date)',
      exposureSec: null,
      pixelScaleArcsec: 6.15,
      fovDeg: null,
      widthPx: null,
      heightPx: null,
      regionPolygon: [],
      targetName: 'WISE 0855',
      calibLevel: null,
      accessUrl: '',
      accessSizeKb: null,
      dataSource: 'NASA/IPAC IRSA SIA2',
    },
    previewImageUrl: '',
  };

  return {
    dateKey: effectiveLocalDate,
    localDate: effectiveLocalDate,
    matchedLocalDate: false,
    featuredIndex: 0,
    items: [fallbackItem],
    isFallback: true,
  };
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'SPHEREx SkyTime Archive Proxy' });
  });

  app.get('/api/targets', (_req, res) => {
    res.json({ targets: CHALLENGE_TARGETS });
  });

  app.get('/api/resolve-target', async (req, res) => {
    try {
      const name = String(req.query.name || '');
      const result = await resolveTargetName(name);
      if (!result.found) {
        res.status(404).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({
        found: false,
        error: err instanceof Error ? err.message : 'Object name lookup error.',
      });
    }
  });

  app.get('/api/observations', async (req, res) => {
    try {
      const raRaw = String(req.query.ra || '');
      const decRaw = String(req.query.dec || '');
      const radiusDeg = req.query.radius ? Number(req.query.radius) : 0.08;
      const collection = String(req.query.collection || 'spherex_dr1');
      const resolvedName = req.query.name ? String(req.query.name) : undefined;

      const raParsed = parseRaInput(raRaw);
      if (raParsed.error) {
        res.status(400).json({ error: raParsed.error });
        return;
      }
      const decParsed = parseDecInput(decRaw);
      if (decParsed.error) {
        res.status(400).json({ error: decParsed.error });
        return;
      }

      const result = await querySpherexObservations({
        raDeg: raParsed.deg,
        decDeg: decParsed.deg,
        radiusDeg: Number.isNaN(radiusDeg) ? 0.08 : radiusDeg,
        collection,
        resolvedName,
      });

      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: `Failed to query SPHEREx observations: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      });
    }
  });

  app.get('/api/fits-inspect', async (req, res) => {
    const accessUrl = String(req.query.access_url || '');
    const raDeg = Number(req.query.ra);
    const decDeg = Number(req.query.dec);
    const sizeDeg = req.query.size ? Number(req.query.size) : 0.08;
    const stretch = (req.query.stretch as 'asinh' | 'log' | 'linear') || 'asinh';
    const subtractZodi = req.query.subtractZodi !== 'false';
    const colormap =
      (req.query.colormap as 'infrared' | 'viridis' | 'grayscale' | 'cool') || 'infrared';

    if (!accessUrl || Number.isNaN(raDeg) || Number.isNaN(decDeg)) {
      res.status(400).json({ error: 'Missing required parameters: access_url, ra, dec.' });
      return;
    }

    try {
      const result = await inspectAndRenderFits({
        accessUrl,
        raDeg,
        decDeg,
        sizeDeg,
        stretch,
        subtractZodi,
        colormap,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof FitsValidationError) {
        const status = err.code === 'TIMEOUT' ? 504 : err.code === 'INVALID_URL' ? 400 : 502;
        res.status(status).json({
          error: err.message,
          errorCode: err.code,
        });
        return;
      }
      res.status(502).json({
        error: `Failed to process SPHEREx FITS cutout: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
        errorCode: 'HTTP_ERROR',
      });
    }
  });

  app.get('/api/fits-diff', async (req, res) => {
    const accessUrlA = String(req.query.access_url_a || '');
    const accessUrlB = String(req.query.access_url_b || '');
    const raDeg = Number(req.query.ra);
    const decDeg = Number(req.query.dec);
    const sizeDeg = req.query.size ? Number(req.query.size) : 0.08;
    const subtractZodi = req.query.subtractZodi !== 'false';
    const thresholdSigma = req.query.thresholdSigma ? Number(req.query.thresholdSigma) : 3.0;
    const matchBackground = req.query.matchBackground !== 'false';
    const alignMode = req.query.alignMode === 'pixel' ? 'pixel' : 'wcs';

    if (!accessUrlA || !accessUrlB || Number.isNaN(raDeg) || Number.isNaN(decDeg)) {
      res.status(400).json({
        error: 'Missing required parameters: access_url_a, access_url_b, ra, dec.',
      });
      return;
    }

    try {
      const result = await computeFitsDifference({
        accessUrlA,
        accessUrlB,
        raDeg,
        decDeg,
        sizeDeg,
        subtractZodi,
        thresholdSigma: Number.isFinite(thresholdSigma) ? thresholdSigma : 3.0,
        matchBackground,
        alignMode,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof FitsValidationError) {
        const status = err.code === 'TIMEOUT' ? 504 : err.code === 'INVALID_URL' ? 400 : 502;
        res.status(status).json({
          error: err.message,
          errorCode: err.code,
        });
        return;
      }
      res.status(502).json({
        error: `Failed to compare SPHEREx FITS cutouts: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
        errorCode: 'HTTP_ERROR',
      });
    }
  });

  app.get('/api/fits-single-hdu', async (req, res) => {
    const accessUrl = String(req.query.access_url || '');
    const raDeg = Number(req.query.ra);
    const decDeg = Number(req.query.dec);
    const sizeDeg = req.query.size ? Number(req.query.size) : 0.08;

    if (!accessUrl || Number.isNaN(raDeg) || Number.isNaN(decDeg)) {
      res.status(400).json({ error: 'Missing required parameters: access_url, ra, dec.' });
      return;
    }

    try {
      const fitsBuf = await buildSingleImageFits(accessUrl, raDeg, decDeg, sizeDeg);
      res.setHeader('Content-Type', 'application/fits');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(fitsBuf);
    } catch (err) {
      res.status(502).json({
        error: `Failed to extract single-HDU FITS: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      });
    }
  });

  app.get('/api/featured', async (req, res) => {
    try {
      const localDate = req.query.localDate ? String(req.query.localDate) : undefined;
      const rawTz = req.query.tzOffsetMin ? Number(req.query.tzOffsetMin) : 0;
      const tzOffsetMin = Number.isFinite(rawTz) ? rawTz : 0;
      const gallery = await buildFeaturedGallery(localDate, tzOffsetMin);
      res.json(gallery);
    } catch (err) {
      res.status(500).json({
        error: `Unable to load featured observations: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      });
    }
  });

  app.get('/api/hips/:surveyId/*', handleHipsProxyRequest);

  // Strict JSON 404 & error handlers for /api/* so Vite never falls back to HTML for API calls
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal API error.',
    });
  });

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`SPHEREx SkyTime server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
