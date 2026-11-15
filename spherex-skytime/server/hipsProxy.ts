import type { Request, Response } from 'express';

interface HipsSurveyConfig {
  key: string;
  mirrors: string[];
}

const HIPS_SURVEYS: Record<string, HipsSurveyConfig> = {
  spherex: {
    key: 'spherex',
    mirrors: [
      'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube',
    ],
  },
  '2mass': {
    key: '2mass',
    mirrors: [
      'https://skies.esac.esa.int/2MASSColor',
      'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color',
    ],
  },
  dss: {
    key: 'dss',
    mirrors: ['https://skies.esac.esa.int/DSSColor'],
  },
  allwise: {
    key: 'allwise',
    mirrors: ['https://skies.esac.esa.int/AllWISEColor'],
  },
};

interface CachedAsset {
  status: number;
  contentType: string;
  body: Buffer;
  timestamp: number;
}

const MAX_CACHE_ITEMS = 450;
const CACHE_TTL_MS = 60 * 60 * 1000;
const tileCache = new Map<string, CachedAsset>();

function setCache(cacheKey: string, entry: CachedAsset) {
  if (tileCache.size >= MAX_CACHE_ITEMS) {
    const oldestKey = tileCache.keys().next().value;
    if (oldestKey) tileCache.delete(oldestKey);
  }
  tileCache.set(cacheKey, entry);
}

function getCache(cacheKey: string): CachedAsset | null {
  const hit = tileCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > CACHE_TTL_MS) {
    tileCache.delete(cacheKey);
    return null;
  }
  // Refresh LRU order
  tileCache.delete(cacheKey);
  tileCache.set(cacheKey, hit);
  return hit;
}

function isSafeHipsSubpath(subpath: string): boolean {
  if (!subpath || subpath.includes('..') || subpath.includes('\\')) return false;
  if (subpath === 'properties' || subpath === 'Moc.fits' || subpath === 'Moc.json') return true;
  return /^(Norder\d+\/(Allsky\.(jpg|jpeg|png|webp|fits)|Dir\d+\/Npix\d+\.(jpg|jpeg|png|webp|fits)))$/.test(
    subpath
  );
}

function normalizeProperties(rawText: string, serviceUrl: string): string {
  const lines = rawText
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return true;
      const eq = trimmed.indexOf('=');
      if (eq < 0) return true;
      const key = trimmed.slice(0, eq).trim();
      return (
        !key.startsWith('hips_service_url') &&
        !key.startsWith('data_cube_') &&
        !key.startsWith('custom_tile_format') &&
        key !== 'dataproduct_type' &&
        key !== 'hips_cube_depth' &&
        key !== 'hips_cube_firstframe' &&
        key !== 'hips_progenitor_url'
      );
    });

  lines.push(`dataproduct_type     = image`);
  lines.push(`hips_service_url     = ${serviceUrl}`);
  return lines.join('\n') + '\n';
}

async function fetchFromMirrors(
  mirrors: string[],
  subpath: string
): Promise<{ status: number; contentType: string; body: Buffer }> {
  let lastError: unknown = null;

  for (const base of mirrors) {
    const url = `${base.replace(/\/+$/, '')}/${subpath}`;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'SPHEREx-SkyTime/1.0 (NASA Space Apps 2026)',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 404) {
        return {
          status: 404,
          contentType: 'text/plain; charset=utf-8',
          body: Buffer.from('Not found'),
        };
      }

      if (!response.ok) {
        lastError = new Error(`Upstream HTTP ${response.status} for ${url}`);
        continue;
      }

      const arrayBuf = await response.arrayBuffer();
      const contentType =
        response.headers.get('content-type') ||
        (subpath === 'properties'
          ? 'text/plain; charset=utf-8'
          : subpath.endsWith('.fits')
            ? 'application/fits'
            : subpath.endsWith('.png')
              ? 'image/png'
              : 'image/jpeg');

      return {
        status: 200,
        contentType,
        body: Buffer.from(arrayBuf),
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to fetch HiPS resource');
}

export async function handleHipsProxyRequest(req: Request, res: Response): Promise<void> {
  const surveyId = String(req.params.surveyId || '').toLowerCase();
  const survey = HIPS_SURVEYS[surveyId];
  if (!survey) {
    res.status(404).json({ error: `Unknown HiPS survey "${surveyId}".` });
    return;
  }

  const rawSubpath = String(req.params[0] || '').replace(/^\/+/, '');
  if (!isSafeHipsSubpath(rawSubpath)) {
    res.status(400).json({ error: 'Invalid HiPS resource path.' });
    return;
  }

  const cacheKey = `${survey.key}:${rawSubpath}`;
  const cached = getCache(cacheKey);

  try {
    let asset = cached;
    if (!asset) {
      const fetched = await fetchFromMirrors(survey.mirrors, rawSubpath);
      asset = {
        ...fetched,
        timestamp: Date.now(),
      };
      setCache(cacheKey, asset);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (asset.status === 404) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }

    if (rawSubpath === 'properties') {
      const forwardedProto = req.headers['x-forwarded-proto'];
      const proto =
        typeof forwardedProto === 'string' && forwardedProto.length > 0
          ? forwardedProto.split(',')[0].trim()
          : req.protocol || 'http';
      const host = req.get('host') || 'localhost:3000';
      const serviceUrl = `${proto}://${host}/api/hips/${survey.key}`;
      const normalized = normalizeProperties(asset.body.toString('utf8'), serviceUrl);
      res.status(200).type('text/plain; charset=utf-8').send(normalized);
      return;
    }

    res.status(200).type(asset.contentType).send(asset.body);
  } catch (err) {
    res.status(502).json({
      error: `Failed to proxy HiPS resource ${survey.key}/${rawSubpath}: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    });
  }
}
