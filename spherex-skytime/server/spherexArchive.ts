import type { SpherexObservation, ObservationsSearchResponse, ChallengeTarget } from '../src/types/spherex.ts';

const IRSA_SIA_BASE = 'https://irsa.ipac.caltech.edu/SIA';
const SESAME_BASE = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV';

export const CHALLENGE_TARGETS: ChallengeTarget[] = [
  {
    id: 'wise-0855',
    name: 'WISE 0855',
    category: 'Y-Type Brown Dwarf',
    raInput: '08h55m10.831s',
    decInput: '-07d14m42.53s',
    raDeg: 133.795129,
    decDeg: -7.245147,
    variabilityType: 'Infrared Brown Dwarf',
    summary:
      'The coldest known brown dwarf (~250 K) just 7.4 light-years away, nearly invisible in optical light yet glowing in SPHEREx mid-infrared bands.',
    whatToLookFor:
      'Compare longer-wavelength detectors (D4–D6, 2.4–5.0 µm) against shorter bands, and look at multi-epoch visits for subtle motion.',
  },
  {
    id: 'barnards-star',
    name: "Barnard's Star",
    category: 'Red Dwarf (M4V)',
    raInput: '17h57m48.498s',
    decInput: '+04d41m36.21s',
    raDeg: 269.452075,
    decDeg: 4.693392,
    variabilityType: 'Positional (High Proper Motion / Parallax)',
    summary:
      'The fastest-moving star in Earth’s night sky (~10.3 arcseconds per year) at only 5.96 light-years away.',
    whatToLookFor:
      'Examine observations separated by several months in matching bands to inspect positional stability and brightness.',
  },
  {
    id: 'epsilon-indi-b',
    name: 'Epsilon Indi B',
    category: 'T-Type Brown Dwarf Binary',
    raInput: '22h04m10.520s',
    decInput: '-56d46m57.70s',
    raDeg: 331.043833,
    decDeg: -56.782694,
    variabilityType: 'Positional (High Proper Motion / Parallax)',
    summary:
      'A nearby binary pair of cool methane-rich brown dwarfs (~11.9 light-years away) with strong near-infrared absorption bands.',
    whatToLookFor:
      'Inspect near-infrared continuum and methane-sensitive wavelength bands between 1.0 and 4.5 µm.',
  },
  {
    id: 'rw-aurigae',
    name: 'RW Aurigae',
    category: 'Young T Tauri Binary',
    raInput: '05h07m49.538s',
    decInput: '+30d24m05.07s',
    raDeg: 76.956408,
    decDeg: 30.401408,
    variabilityType: 'Brightness Variability',
    summary:
      'A young star system surrounded by a dusty protoplanetary disk that periodically dims and brightens as dust clumps pass in front.',
    whatToLookFor:
      'Compare calibrated MJy/sr brightness across different observation dates within matching SPHEREx detector bands.',
  },
  {
    id: 'r-draconis',
    name: 'R Draconis',
    category: 'Mira Variable Giant',
    raInput: '16h32m40.230s',
    decInput: '+66d45m17.90s',
    raDeg: 248.167625,
    decDeg: 66.754972,
    variabilityType: 'Brightness Variability',
    summary:
      'A pulsating red giant star whose brightness varies dramatically over a ~245-day cycle as its outer layers expand and cool.',
    whatToLookFor:
      'Look at the chronological brightness curve across SPHEREx passes and compare strong infrared emission across bands.',
  },
];

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const queryCache = new Map<string, CacheEntry<ObservationsSearchResponse>>();
const CACHE_TTL_MS = 15 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 2 * 60 * 1000;

import { querySpherexCubeObservations } from './spherexCube.ts';

export function mjdToIsoDate(mjd: number): string {
  // MJD 40587.0 = 1970-01-01T00:00:00.000Z
  const unixMs = (mjd - 40587.0) * 86400 * 1000;
  return new Date(unixMs).toISOString();
}

export function formatIsoShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function formatRaHms(raDeg: number): string {
  const norm = ((raDeg % 360) + 360) % 360;
  const totalHours = norm / 15;
  const h = Math.floor(totalHours);
  const remMin = (totalHours - h) * 60;
  const m = Math.floor(remMin);
  const s = (remMin - m) * 60;
  return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m${s.toFixed(3).padStart(6, '0')}s`;
}

export function formatDecDms(decDeg: number): string {
  const sign = decDeg < 0 ? '-' : '+';
  const abs = Math.abs(decDeg);
  const d = Math.floor(abs);
  const remMin = (abs - d) * 60;
  const m = Math.floor(remMin);
  const s = (remMin - m) * 60;
  return `${sign}${String(d).padStart(2, '0')}d${String(m).padStart(2, '0')}m${s.toFixed(2).padStart(5, '0')}s`;
}

/**
 * Parses Right Ascension from sexagesimal (08h55m10.831s, 08:55:10.831, 08 55 10.831)
 * or decimal degrees (0..360).
 */
export function parseRaInput(input: string): { deg: number; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { deg: NaN, error: 'Right Ascension is required.' };

  // Plain decimal degrees
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const val = Number(trimmed);
    if (Number.isNaN(val) || val < 0 || val > 360) {
      return { deg: NaN, error: 'Decimal RA must be between 0° and 360°.' };
    }
    return { deg: val };
  }

  // Sexagesimal HMS: 08h55m10.831s or 08:55:10.831 or 08 55 10.831
  const hmsMatch = trimmed.match(
    /^(\d{1,2})\s*[h:\s]\s*(\d{1,2})\s*[m:\s]\s*(\d{1,2}(?:\.\d+)?)\s*s?$/i
  );
  if (hmsMatch) {
    const h = Number(hmsMatch[1]);
    const m = Number(hmsMatch[2]);
    const s = Number(hmsMatch[3]);
    if (h < 0 || h >= 24 || m < 0 || m >= 60 || s < 0 || s >= 60) {
      return { deg: NaN, error: 'RA hours must be 0–23, minutes and seconds 0–59.99.' };
    }
    return { deg: (h + m / 60 + s / 3600) * 15 };
  }

  return {
    deg: NaN,
    error: 'Invalid RA format. Try "08h55m10.831s", "08:55:10.83", or decimal degrees like "133.795".',
  };
}

/**
 * Parses Declination from sexagesimal (-07d14m42.53s, -07:14:42.53, +30 24 05.1)
 * or decimal degrees (-90..+90).
 */
export function parseDecInput(input: string): { deg: number; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { deg: NaN, error: 'Declination is required.' };

  // Plain decimal degrees
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const val = Number(trimmed);
    if (Number.isNaN(val) || val < -90 || val > 90) {
      return { deg: NaN, error: 'Decimal Dec must be between -90° and +90°.' };
    }
    return { deg: val };
  }

  // Sexagesimal DMS
  const dmsMatch = trimmed.match(
    /^([+-]?)\s*(\d{1,2})\s*[d°:\s]\s*(\d{1,2})\s*[m':\s]\s*(\d{1,2}(?:\.\d+)?)\s*[s"]?$/i
  );
  if (dmsMatch) {
    const sign = dmsMatch[1] === '-' ? -1 : 1;
    const d = Number(dmsMatch[2]);
    const m = Number(dmsMatch[3]);
    const s = Number(dmsMatch[4]);
    if (d < 0 || d > 90 || m < 0 || m >= 60 || s < 0 || s >= 60) {
      return { deg: NaN, error: 'Dec degrees must be -90 to +90, minutes and seconds 0–59.99.' };
    }
    const val = sign * (d + m / 60 + s / 3600);
    if (val < -90 || val > 90) {
      return { deg: NaN, error: 'Declination magnitude cannot exceed 90°.' };
    }
    return { deg: val };
  }

  return {
    deg: NaN,
    error: 'Invalid Dec format. Try "-07d14m42.53s", "-07:14:42.5", or decimal degrees like "-7.245".',
  };
}

export async function resolveTargetName(
  name: string
): Promise<{ found: boolean; name: string; raDeg?: number; decDeg?: number; raHms?: string; decDms?: string; source?: string; error?: string }> {
  const clean = name.trim();
  if (!clean) {
    return { found: false, name: '', error: 'Please enter an astronomical object name.' };
  }

  // Check challenge target aliases first for instant accuracy
  const normalized = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matched = CHALLENGE_TARGETS.find((t) => {
    const tNorm = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return tNorm === normalized || tNorm.includes(normalized) || (normalized.includes('wise0855') && t.id === 'wise-0855');
  });
  if (matched) {
    return {
      found: true,
      name: matched.name,
      raDeg: matched.raDeg,
      decDeg: matched.decDeg,
      raHms: matched.raInput,
      decDms: matched.decInput,
      source: 'Challenge Target Catalog (ICRS J2000)',
    };
  }

  // Query CDS Sesame Name Resolver (SIMBAD + NED + VizieR)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const resp = await fetch(`${SESAME_BASE}?${encodeURIComponent(clean)}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      return { found: false, name: clean, error: `Name resolver returned HTTP ${resp.status}.` };
    }
    const xml = await resp.text();
    const jradeg = xml.match(/<jradeg>([\d.-]+)<\/jradeg>/);
    const jdedeg = xml.match(/<jdedeg>([\d.+-]+)<\/jdedeg>/);
    const oname = xml.match(/<oname>([^<]+)<\/oname>/);
    if (jradeg && jdedeg) {
      const raDeg = Number(jradeg[1]);
      const decDeg = Number(jdedeg[1]);
      return {
        found: true,
        name: oname?.[1]?.trim() || clean,
        raDeg,
        decDeg,
        raHms: formatRaHms(raDeg),
        decDms: formatDecDms(decDeg),
        source: 'CDS Sesame (SIMBAD/NED)',
      };
    }
    return {
      found: false,
      name: clean,
      error: `Could not resolve "${clean}" via CDS Sesame. Try entering RA and Dec directly.`,
    };
  } catch (err) {
    return {
      found: false,
      name: clean,
      error: `Name resolution request failed (${err instanceof Error ? err.message : 'network error'}).`,
    };
  }
}

function parsePolygon(sRegion: string): number[][] {
  if (!sRegion || !sRegion.toUpperCase().includes('POLYGON')) return [];
  const nums = sRegion
    .replace(/POLYGON\s*(ICRS)?/i, '')
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const pts: number[][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push([nums[i], nums[i + 1]]);
  }
  return pts;
}

function parseDetectorNumber(bandpass: string): number | null {
  const m = bandpass.match(/D(\d)/i);
  return m ? Number(m[1]) : null;
}

function buildSiaRowsToObservations(
  fields: string[],
  rows: string[][],
  raDeg: number,
  decDeg: number,
  collection: string
): SpherexObservation[] {
  return rows
    .map((row, idx): SpherexObservation | null => {
      const record: Record<string, string> = {};
      fields.forEach((f, i) => {
        record[f] = row[i] ?? '';
      });

      const accessUrl = record['access_url'] || '';
      const obsId = record['obs_id'] || `obs-${idx}`;
      const tMin = Number(record['t_min']);
      const tMax = Number(record['t_max']);
      if (!accessUrl || Number.isNaN(tMin)) return null;

      const emMinM = Number(record['em_min']);
      const emMaxM = Number(record['em_max']);
      const emMinUm = !Number.isNaN(emMinM) && emMinM > 0 ? Number((emMinM * 1e6).toFixed(4)) : null;
      const emMaxUm = !Number.isNaN(emMaxM) && emMaxM > 0 ? Number((emMaxM * 1e6).toFixed(4)) : null;
      const emCenterUm =
        emMinUm !== null && emMaxUm !== null
          ? Number(((emMinUm + emMaxUm) / 2).toFixed(4))
          : null;

      const obsDateIso = mjdToIsoDate(tMin);
      const bandpassName = record['energy_bandpassname'] || 'SPHEREx';

      return {
        id: record['obs_publisher_did'] || `${obsId}-${bandpassName}`,
        obsId,
        publisherDid: record['obs_publisher_did'] || '',
        collection: record['obs_collection'] || collection,
        bandpassName,
        detectorNumber: parseDetectorNumber(bandpassName),
        emMinUm,
        emMaxUm,
        emCenterUm,
        emResPower: record['em_res_power'] ? Number(record['em_res_power']) : null,
        raDeg: Number(record['s_ra']) || raDeg,
        decDeg: Number(record['s_dec']) || decDeg,
        raHms: formatRaHms(Number(record['s_ra']) || raDeg),
        decDms: formatDecDms(Number(record['s_dec']) || decDeg),
        tMinMjd: tMin,
        tMaxMjd: Number.isNaN(tMax) ? tMin : tMax,
        obsDateIso,
        obsDateDisplay: formatIsoShort(obsDateIso),
        exposureSec: record['t_exptime'] ? Number(record['t_exptime']) : null,
        pixelScaleArcsec: record['s_pixel_scale'] ? Number(record['s_pixel_scale']) : null,
        fovDeg: record['s_fov'] ? Number(record['s_fov']) : null,
        widthPx: record['s_xel1'] ? Number(record['s_xel1']) : null,
        heightPx: record['s_xel2'] ? Number(record['s_xel2']) : null,
        regionPolygon: parsePolygon(record['s_region'] || ''),
        targetName: record['target_name'] || '',
        calibLevel: record['calib_level'] ? Number(record['calib_level']) : null,
        accessUrl,
        accessSizeKb: record['access_estsize'] ? Number(record['access_estsize']) : null,
        dataSource: 'NASA/IPAC IRSA SIA2',
      };
    })
    .filter((x): x is SpherexObservation => x !== null)
    .sort((a, b) => a.tMinMjd - b.tMinMjd);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseVotableXml(xml: string): { status: string; fields: string[]; rows: string[][] } {
  const statusMatch = xml.match(/<INFO\b[^>]*name=["']QUERY_STATUS["'][^>]*value=["']([^"']+)["']/i);
  const status = statusMatch ? statusMatch[1] : 'OK';

  const fields: string[] = [];
  const fieldRegex = /<FIELD\b[^>]*name=["']([^"']+)["'][^>]*>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRegex.exec(xml)) !== null) {
    fields.push(fm[1]);
  }

  const rows: string[][] = [];
  const trRegex = /<TR\b[^>]*>([\s\S]*?)<\/TR>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(xml)) !== null) {
    const row: string[] = [];
    const tdRegex = /<TD\b[^>]*>([\s\S]*?)<\/TD>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      row.push(decodeXmlEntities(tdMatch[1].trim()));
    }
    if (row.length > 0) rows.push(row);
  }
  return { status, fields, rows };
}

async function fetchSiaWithRetry(
  url: string,
  maxAttempts = 2,
  timeoutMs = 6500
): Promise<globalThis.Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'SPHEREx-SkyTime/1.0 (NASA Space Apps 2026)',
          Accept: 'application/json, application/x-votable+xml, text/xml;q=0.9',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ([429, 500, 502, 503, 504].includes(resp.status) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('IRSA SIA2 request failed.');
}

export async function querySpherexObservations(params: {
  raDeg: number;
  decDeg: number;
  radiusDeg?: number;
  collection?: string;
  resolvedName?: string;
}): Promise<ObservationsSearchResponse> {
  const raDeg = params.raDeg;
  const decDeg = params.decDeg;
  const radiusDeg = Math.min(Math.max(params.radiusDeg ?? 0.08, 0.005), 0.5);
  const collection = params.collection || 'spherex_dr1';

  const cacheKey = `${collection}:${raDeg.toFixed(5)}:${decDeg.toFixed(5)}:${radiusDeg.toFixed(3)}`;
  const cached = queryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.value,
      query: { ...cached.value.query, resolvedName: params.resolvedName },
    };
  }

  const siaUrl = new URL(IRSA_SIA_BASE);
  siaUrl.searchParams.set('COLLECTION', collection);
  siaUrl.searchParams.set('POS', `circle ${raDeg.toFixed(6)} ${decDeg.toFixed(6)} ${radiusDeg.toFixed(4)}`);
  siaUrl.searchParams.set('RESPONSEFORMAT', 'JSON');

  let siaFailureReason = '';

  try {
    const resp = await fetchSiaWithRetry(siaUrl.toString(), 2, 6500);

    if (resp.ok) {
      const json = (await resp.json()) as {
        VOTABLE?: {
          RESOURCE_ARRAY?: Array<{
            '<xmlattr>'?: { type?: string };
            INFO_ARRAY?: Array<{ '<xmlattr>'?: { name?: string; value?: string } }>;
            TABLE?: {
              FIELD_ARRAY?: Array<{ '<xmlattr>'?: { name?: string } }>;
              DATA?: { TABLEDATA?: string[][] };
            };
          }>;
        };
      };

      const resultsResource = json.VOTABLE?.RESOURCE_ARRAY?.find(
        (r) => r['<xmlattr>']?.type === 'results'
      );
      const queryStatus = resultsResource?.INFO_ARRAY?.find(
        (i) => i['<xmlattr>']?.name === 'QUERY_STATUS'
      )?.['<xmlattr>']?.value;

      if (!queryStatus || queryStatus === 'OK') {
        const fields = resultsResource?.TABLE?.FIELD_ARRAY?.map((f) => f['<xmlattr>']?.name || '') || [];
        const rows = resultsResource?.TABLE?.DATA?.TABLEDATA || [];
        const observations = buildSiaRowsToObservations(fields, rows, raDeg, decDeg, collection);

        const result: ObservationsSearchResponse = {
          query: {
            raDeg,
            decDeg,
            raHms: formatRaHms(raDeg),
            decDms: formatDecDms(decDeg),
            radiusDeg,
            collection,
            resolvedName: params.resolvedName,
          },
          sourceStatus: observations.length > 0 ? 'live-irsa' : 'empty',
          totalCount: observations.length,
          observations,
        };

        queryCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
        return result;
      }
      siaFailureReason = `IRSA SIA2 query status: ${queryStatus}`;
    } else {
      siaFailureReason = `NASA/IPAC IRSA SIA2 service returned HTTP ${resp.status}.`;
      // Try VOTABLE XML format once if JSON endpoint errored cleanly with non-502 status
      if (resp.status !== 502 && resp.status !== 503) {
        const votUrl = new URL(siaUrl.toString());
        votUrl.searchParams.set('RESPONSEFORMAT', 'VOTABLE');
        const votResp = await fetchSiaWithRetry(votUrl.toString(), 1, 6000);
        if (votResp.ok) {
          const parsed = parseVotableXml(await votResp.text());
          if (parsed.status === 'OK') {
            const observations = buildSiaRowsToObservations(
              parsed.fields,
              parsed.rows,
              raDeg,
              decDeg,
              collection
            );
            const result: ObservationsSearchResponse = {
              query: {
                raDeg,
                decDeg,
                raHms: formatRaHms(raDeg),
                decDms: formatDecDms(decDeg),
                radiusDeg,
                collection,
                resolvedName: params.resolvedName,
              },
              sourceStatus: observations.length > 0 ? 'live-irsa' : 'empty',
              totalCount: observations.length,
              observations,
            };
            queryCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
            return result;
          }
        }
      }
    }
  } catch (err) {
    siaFailureReason = `Unable to reach NASA/IPAC IRSA SIA2 (${
      err instanceof Error ? err.message : 'network error'
    }).`;
  }

  // If we have a previous successful live-irsa cache entry, serve it cleanly rather than failing
  if (cached && cached.value.sourceStatus === 'live-irsa' && cached.value.totalCount > 0) {
    return {
      ...cached.value,
      query: { ...cached.value.query, resolvedName: params.resolvedName },
    };
  }

  // Automatic Live Fallback: NASA/IPAC SPHEREx DR1 Order-5 All-Sky Spectral Cube (IRSA / AWS Open Data S3)
  try {
    const cubeResult = await querySpherexCubeObservations({
      raDeg,
      decDeg,
      radiusDeg,
      collection,
      resolvedName: params.resolvedName,
      upstreamError: siaFailureReason,
    });
    if (cubeResult.totalCount > 0) {
      queryCache.set(cacheKey, {
        value: cubeResult,
        expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
      });
    }
    return cubeResult;
  } catch (cubeErr) {
    const cubeErrMsg = cubeErr instanceof Error ? cubeErr.message : 'Cube fallback unavailable';
    return {
      query: {
        raDeg,
        decDeg,
        raHms: formatRaHms(raDeg),
        decDms: formatDecDms(decDeg),
        radiusDeg,
        collection,
        resolvedName: params.resolvedName,
      },
      sourceStatus: 'irsa-error',
      errorMessage: `${siaFailureReason} SPHEREx DR1 Spectral Cube fallback also failed: ${cubeErrMsg}`,
      totalCount: 0,
      observations: [],
    };
  }
}
