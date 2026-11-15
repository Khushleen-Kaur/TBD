import type { ObservationsSearchResponse, SpherexObservation } from '../src/types/spherex.ts';

const S3_HIPS5_BASE = 'https://nasa-irsa-spherex.s3.amazonaws.com/dr1/hips5_cube/hips_20261026';
const IRSA_HIPS5_BASE = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';

const NSIDE_ORDER5 = 32;
const TILE_DIM = 512;
const NUM_CHANNELS = 102;
const PLANE_FLOAT_BYTES = TILE_DIM * TILE_DIM * 4; // 1,048,576 bytes
const HEADER_PROBE_BYTES = 14400; // 5 FITS blocks (plenty for Primary + Image headers)

export interface SpectralChannelMeta {
  plane: number; // 1..102
  detector: number; // 1..6
  channelInDetector: number; // 1..17
  lambdaEffUm: number;
  lambdaMinUm: number;
  lambdaMaxUm: number;
  resPower: number;
  bandwidthUm: number;
}

interface CubeHeaderInfo {
  npix: number;
  dir: number;
  mjdBeg: number;
  mjdEnd: number;
  dateBeg: string;
  dateEnd: string;
  blankChannels: Set<string>;
  crpix1: number;
  crpix2: number;
  pc11: number;
  pc12: number;
  pc21: number;
  pc22: number;
  imageDataStart: number;
  flagsDataStart: number;
  spectralChannelsDataStart: number;
  spectralChannelsBytes: number;
}

const cubeHeaderCache = new Map<number, CubeHeaderInfo>();
const planeDataCache = new Map<string, Float32Array>();
const flagsPlaneCache = new Map<string, Int32Array>();
const MAX_CUBE_PLANE_CACHE = 160;
let spectralMetaPromise: Promise<SpectralChannelMeta[]> | null = null;

function formatMjdIso(mjd: number): string {
  const unixMs = (mjd - 40587.0) * 86400 * 1000;
  return new Date(unixMs).toISOString();
}

function formatRaHmsLocal(raDeg: number): string {
  const norm = ((raDeg % 360) + 360) % 360;
  const totalHours = norm / 15;
  const h = Math.floor(totalHours);
  const remMin = (totalHours - h) * 60;
  const m = Math.floor(remMin);
  const s = (remMin - m) * 60;
  return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m${s.toFixed(3).padStart(6, '0')}s`;
}

function formatDecDmsLocal(decDeg: number): string {
  const sign = decDeg < 0 ? '-' : '+';
  const abs = Math.abs(decDeg);
  const d = Math.floor(abs);
  const remMin = (abs - d) * 60;
  const m = Math.floor(remMin);
  const s = (remMin - m) * 60;
  return `${sign}${String(d).padStart(2, '0')}d${String(m).padStart(2, '0')}m${s.toFixed(2).padStart(5, '0')}s`;
}

/**
 * Exact HEALPix Order-5 (NSIDE=32, 12,288 tiles) NESTED pixel lookup for ICRS (RA, Dec).
 */
export function ang2pixNest32(raDeg: number, decDeg: number): { npix: number; dir: number } {
  const clampedDec = Math.max(-89.999999, Math.min(89.999999, decDeg));
  const theta = ((90.0 - clampedDec) * Math.PI) / 180.0;
  const phi = ((((raDeg % 360.0) + 360.0) % 360.0) * Math.PI) / 180.0;
  const z = Math.cos(theta);
  const za = Math.abs(z);
  const tt = (phi / (0.5 * Math.PI)) % 4.0;

  let face = 0;
  let ix = 0;
  let iy = 0;

  if (za <= 2.0 / 3.0) {
    const temp1 = NSIDE_ORDER5 * (0.5 + tt);
    const temp2 = NSIDE_ORDER5 * z * 0.75;
    const jp = Math.floor(temp1 - temp2);
    const jm = Math.floor(temp1 + temp2);
    const ifp = Math.floor(jp / NSIDE_ORDER5);
    const ifm = Math.floor(jm / NSIDE_ORDER5);

    if (ifp === ifm) {
      face = ifp | 4;
    } else if (ifp < ifm) {
      face = ifp;
    } else {
      face = ifm + 8;
    }
    ix = jm & (NSIDE_ORDER5 - 1);
    iy = NSIDE_ORDER5 - (jp & (NSIDE_ORDER5 - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = NSIDE_ORDER5 * Math.sqrt(3.0 * (1.0 - za));
    const jp = Math.min(NSIDE_ORDER5 - 1, Math.floor(tp * tmp));
    const jm = Math.min(NSIDE_ORDER5 - 1, Math.floor((1.0 - tp) * tmp));
    if (z >= 0) {
      face = ntt;
      ix = NSIDE_ORDER5 - jm - 1;
      iy = NSIDE_ORDER5 - jp - 1;
    } else {
      face = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }

  let pix = 0;
  for (let b = 0; b < 5; b++) {
    pix |= ((ix >> b) & 1) << (2 * b);
    pix |= ((iy >> b) & 1) << (2 * b + 1);
  }
  const npix = (face << 10) + pix;
  const dir = Math.floor(npix / 10000) * 10000;
  return { npix, dir };
}

export function getCubeTileMirrorUrls(npix: number, dir: number): string[] {
  const subpath = `Norder5/Dir${dir}/Npix${npix}_cube.fits`;
  return [`${S3_HIPS5_BASE}/${subpath}`, `${IRSA_HIPS5_BASE}/${subpath}`];
}

export function parseCubeAccessUrl(
  urlStr: string
): { npix: number; dir: number; plane: number } | null {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\/Norder5\/Dir(\d+)\/Npix(\d+)_cube\.fits$/i);
    if (!m) return null;
    const dir = Number(m[1]);
    const npix = Number(m[2]);
    const plane = Number(u.searchParams.get('plane') || '1');
    if (
      !Number.isInteger(npix) ||
      npix < 0 ||
      npix >= 12288 ||
      !Number.isInteger(plane) ||
      plane < 1 ||
      plane > NUM_CHANNELS
    ) {
      return null;
    }
    return { npix, dir, plane };
  } catch {
    return null;
  }
}

async function fetchByteRangeFromMirrors(
  urls: string[],
  startByte: number,
  endByte: number,
  timeoutMs = 15_000
): Promise<Buffer> {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          Range: `bytes=${startByte}-${endByte}`,
          'User-Agent': 'SPHEREx-SkyTime/1.0 (NASA Space Apps 2026)',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.status !== 206 && resp.status !== 200) {
        lastError = new Error(`HTTP ${resp.status} from ${url}`);
        continue;
      }
      const ab = await resp.arrayBuffer();
      const buf = Buffer.from(ab);
      if (resp.status === 200 && buf.length > endByte) {
        return buf.subarray(startByte, endByte + 1);
      }
      return buf;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to fetch SPHEREx DR1 cube byte range.');
}

function parseAsciiCards(buf: Buffer): Array<{ kv: Map<string, string>; endOffset: number }> {
  const hdus: Array<{ kv: Map<string, string>; endOffset: number }> = [];
  let offset = 0;

  while (offset + 2880 <= buf.length) {
    const kv = new Map<string, string>();
    let foundEnd = false;
    while (offset + 2880 <= buf.length) {
      const block = buf.subarray(offset, offset + 2880).toString('ascii');
      offset += 2880;
      for (let i = 0; i < 36; i++) {
        const card = block.slice(i * 80, (i + 1) * 80);
        if (card[8] === '=' && card[9] === ' ') {
          const key = card.slice(0, 8).trim();
          let val = card.slice(10);
          if (val.trim().startsWith("'")) {
            const m = val.match(/'([^']*)'/);
            kv.set(key, m ? m[1].trim() : '');
          } else {
            const slashIdx = val.indexOf('/');
            if (slashIdx !== -1) val = val.slice(0, slashIdx);
            kv.set(key, val.trim());
          }
        }
        if (card.startsWith('END     ')) {
          foundEnd = true;
          break;
        }
      }
      if (foundEnd) break;
    }
    if (!foundEnd) break;
    hdus.push({ kv, endOffset: offset });
    // Only sequential empty-data primary header transitions cleanly into HDU 1 in header probe
    const naxis = Number(kv.get('NAXIS') || 0);
    if (naxis > 0) break;
  }
  return hdus;
}

export async function fetchCubeHeaderInfo(npix: number, dir: number): Promise<CubeHeaderInfo> {
  const cached = cubeHeaderCache.get(npix);
  if (cached) return cached;

  const urls = getCubeTileMirrorUrls(npix, dir);
  const probe = await fetchByteRangeFromMirrors(urls, 0, HEADER_PROBE_BYTES - 1, 12_000);
  const hdus = parseAsciiCards(probe);

  if (hdus.length < 2) {
    throw new Error(`SPHEREx DR1 cube Npix${npix} header did not expose IMAGE HDU.`);
  }

  const primary = hdus[0].kv;
  const img = hdus[1].kv;
  const imageDataStart = hdus[1].endOffset;

  // Each 3D image cube (512x512x102 float32/int32) = 106,954,752 bytes padded to 2880
  const cubeBytesPadded = Math.ceil((TILE_DIM * TILE_DIM * NUM_CHANNELS * 4) / 2880) * 2880;
  // Probe up to 6 FITS blocks (17,280 bytes) per extension header (FLAGS has 4 blocks of bitmask cards)
  const nhitsHdrOffset = imageDataStart + cubeBytesPadded;
  const nhitsHdrBuf = await fetchByteRangeFromMirrors(urls, nhitsHdrOffset, nhitsHdrOffset + 17279, 10_000);
  const nhitsHdus = parseAsciiCards(nhitsHdrBuf);
  if (nhitsHdus.length === 0) {
    throw new Error(`SPHEREx DR1 cube Npix${npix} NHITS header parse failed.`);
  }
  const nhitsDataStart = nhitsHdrOffset + nhitsHdus[0].endOffset;

  const flagsHdrOffset = nhitsDataStart + cubeBytesPadded;
  const flagsHdrBuf = await fetchByteRangeFromMirrors(urls, flagsHdrOffset, flagsHdrOffset + 17279, 10_000);
  const flagsHdus = parseAsciiCards(flagsHdrBuf);
  if (flagsHdus.length === 0) {
    throw new Error(`SPHEREx DR1 cube Npix${npix} FLAGS header parse failed.`);
  }
  const flagsDataStart = flagsHdrOffset + flagsHdus[0].endOffset;

  const scHdrOffset = flagsDataStart + cubeBytesPadded;
  const scHdrBuf = await fetchByteRangeFromMirrors(urls, scHdrOffset, scHdrOffset + 8639, 10_000);
  const scHdus = parseAsciiCards(scHdrBuf);
  if (scHdus.length === 0) {
    throw new Error(`SPHEREx DR1 cube Npix${npix} SPECTRAL_CHANNELS header parse failed.`);
  }
  const spectralChannelsDataStart = scHdrOffset + scHdus[0].endOffset;

  const blankRaw = primary.get('BLANKCH') || '';
  const blankChannels = new Set(
    blankRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const mjdBeg = Number(primary.get('MJD-BEG')) || 60882.05;
  const mjdEnd = Number(primary.get('MJD-END')) || 61078.63;

  const info: CubeHeaderInfo = {
    npix,
    dir,
    mjdBeg,
    mjdEnd,
    dateBeg: primary.get('DATE-BEG') || formatMjdIso(mjdBeg),
    dateEnd: primary.get('DATE-END') || formatMjdIso(mjdEnd),
    blankChannels,
    crpix1: Number(img.get('CRPIX1')),
    crpix2: Number(img.get('CRPIX2')),
    pc11: Number(img.get('PC1_1')),
    pc12: Number(img.get('PC1_2')),
    pc21: Number(img.get('PC2_1')),
    pc22: Number(img.get('PC2_2')),
    imageDataStart,
    flagsDataStart,
    spectralChannelsDataStart,
    spectralChannelsBytes: 28 * NUM_CHANNELS,
  };

  cubeHeaderCache.set(npix, info);
  return info;
}

export async function getSpectralChannelsMeta(): Promise<SpectralChannelMeta[]> {
  if (spectralMetaPromise) return spectralMetaPromise;

  spectralMetaPromise = (async () => {
    const info = await fetchCubeHeaderInfo(0, 0);
    const urls = getCubeTileMirrorUrls(0, 0);
    const buf = await fetchByteRangeFromMirrors(
      urls,
      info.spectralChannelsDataStart,
      info.spectralChannelsDataStart + info.spectralChannelsBytes - 1,
      12_000
    );

    const channels: SpectralChannelMeta[] = [];
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const off = i * 28;
      const detector = buf.readInt16BE(off);
      const channelInDetector = buf.readInt16BE(off + 2);
      const lambdaEffUm = buf.readFloatBE(off + 4);
      const lambdaMinUm = buf.readFloatBE(off + 8);
      const lambdaMaxUm = buf.readFloatBE(off + 12);
      const resPower = buf.readFloatBE(off + 16);
      const bandwidthUm = buf.readFloatBE(off + 24);
      channels.push({
        plane: i + 1,
        detector,
        channelInDetector,
        lambdaEffUm,
        lambdaMinUm,
        lambdaMaxUm,
        resPower,
        bandwidthUm,
      });
    }
    return channels;
  })().catch((err) => {
    spectralMetaPromise = null;
    throw err;
  });

  return spectralMetaPromise;
}

/**
 * Inverse Calabretta & Roukema (2007) RA---HPX / DEC--HPX projection for tile pixel (px, py).
 * Tests both phi in [-180, 180] and [0, 360] branch cuts to pick the solution inside [0, 512).
 */
export function hpxSkyToTilePixel(
  raDeg: number,
  decDeg: number,
  hdr: Pick<CubeHeaderInfo, 'crpix1' | 'crpix2' | 'pc11' | 'pc12' | 'pc21' | 'pc22'>
): { x: number; y: number } | null {
  const sinT = Math.sin((decDeg * Math.PI) / 180.0);
  const normPhi = (((raDeg % 360.0) + 360.0) % 360.0);
  const candidates = [normPhi > 180.0 ? normPhi - 360.0 : normPhi, normPhi, normPhi - 360.0];
  const det = hdr.pc11 * hdr.pc22 - hdr.pc12 * hdr.pc21;
  if (Math.abs(det) < 1e-18) return null;

  let best: { x: number; y: number; dist2: number } | null = null;

  for (const phi of candidates) {
    let xProj: number;
    let yProj: number;

    if (Math.abs(sinT) <= 2.0 / 3.0) {
      xProj = phi;
      yProj = 45.0 * 1.5 * sinT;
    } else {
      const sigma = Math.sqrt(Math.max(0, 3.0 * (1.0 - Math.abs(sinT))));
      const phiC = -180.0 + (Math.floor((phi + 180.0) / 90.0) + 0.5) * 90.0;
      xProj = phiC + (phi - phiC) * sigma;
      yProj = (decDeg >= 0 ? 1.0 : -1.0) * 45.0 * (2.0 - sigma);
    }

    const dx = (hdr.pc22 * xProj - hdr.pc12 * yProj) / det;
    const dy = (-hdr.pc21 * xProj + hdr.pc11 * yProj) / det;
    const px = hdr.crpix1 - 1 + dx;
    const py = hdr.crpix2 - 1 + dy;
    const dist2 = (px - 255.5) ** 2 + (py - 255.5) ** 2;

    if (!best || dist2 < best.dist2) {
      best = { x: px, y: py, dist2 };
    }
  }

  return best ? { x: best.x, y: best.y } : null;
}

function tanPixelToWorld(
  ox: number,
  oy: number,
  crval1: number,
  crval2: number,
  crpix1: number,
  crpix2: number,
  cdelt1: number,
  cdelt2: number
): { raDeg: number; decDeg: number } | null {
  const deg2rad = Math.PI / 180.0;
  const xi = ((ox - (crpix1 - 1)) * cdelt1) * deg2rad;
  const eta = ((oy - (crpix2 - 1)) * cdelt2) * deg2rad;

  const alpha0 = crval1 * deg2rad;
  const delta0 = crval2 * deg2rad;
  const sinD0 = Math.sin(delta0);
  const cosD0 = Math.cos(delta0);

  const rho = Math.hypot(xi, eta);
  if (rho < 1e-15) {
    return { raDeg: ((crval1 % 360) + 360) % 360, decDeg: crval2 };
  }

  const c = Math.atan(rho);
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);

  const sinD = Math.max(-1, Math.min(1, cosC * sinD0 + (eta * sinC * cosD0) / rho));
  const delta = Math.asin(sinD);
  const alpha = alpha0 + Math.atan2(xi * sinC, rho * cosD0 * cosC - eta * sinD0 * sinC);

  return {
    raDeg: (((alpha / deg2rad) % 360) + 360) % 360,
    decDeg: delta / deg2rad,
  };
}

function setPlaneCache<T>(map: Map<string, T>, key: string, val: T) {
  if (map.size >= MAX_CUBE_PLANE_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, val);
}

async function fetchTilePlaneData(
  npix: number,
  dir: number,
  plane: number
): Promise<{ image: Float32Array; flags: Int32Array | null; header: CubeHeaderInfo; sourceUrl: string }> {
  const header = await fetchCubeHeaderInfo(npix, dir);
  const cacheKey = `${npix}:${plane}`;
  const urls = getCubeTileMirrorUrls(npix, dir);
  const planeIdx = plane - 1;

  let image = planeDataCache.get(cacheKey);
  if (!image) {
    const start = header.imageDataStart + planeIdx * PLANE_FLOAT_BYTES;
    const raw = await fetchByteRangeFromMirrors(urls, start, start + PLANE_FLOAT_BYTES - 1, 18_000);
    if (raw.length < PLANE_FLOAT_BYTES) {
      throw new Error(`SPHEREx DR1 cube plane ${plane} bytes incomplete.`);
    }
    const floats = new Float32Array(TILE_DIM * TILE_DIM);
    for (let i = 0; i < floats.length; i++) {
      floats[i] = raw.readFloatBE(i * 4);
    }
    image = floats;
    setPlaneCache(planeDataCache, cacheKey, image);
  }

  let flags = flagsPlaneCache.get(cacheKey) || null;
  if (!flags) {
    try {
      const fStart = header.flagsDataStart + planeIdx * PLANE_FLOAT_BYTES;
      const fRaw = await fetchByteRangeFromMirrors(urls, fStart, fStart + PLANE_FLOAT_BYTES - 1, 12_000);
      if (fRaw.length >= PLANE_FLOAT_BYTES) {
        const ints = new Int32Array(TILE_DIM * TILE_DIM);
        for (let i = 0; i < ints.length; i++) {
          ints[i] = fRaw.readInt32BE(i * 4);
        }
        flags = ints;
        setPlaneCache(flagsPlaneCache, cacheKey, flags);
      }
    } catch {
      flags = null;
    }
  }

  return { image, flags, header, sourceUrl: `${urls[0]}?plane=${plane}` };
}

function sampleTileBilinear(image: Float32Array, x: number, y: number): number {
  if (x < -0.5 || x > TILE_DIM - 0.5 || y < -0.5 || y > TILE_DIM - 0.5) return NaN;
  const cx = Math.min(TILE_DIM - 1, Math.max(0, x));
  const cy = Math.min(TILE_DIM - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(TILE_DIM - 1, x0 + 1);
  const y1 = Math.min(TILE_DIM - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const corners = [
    { v: image[y0 * TILE_DIM + x0], w: (1 - fx) * (1 - fy) },
    { v: image[y0 * TILE_DIM + x1], w: fx * (1 - fy) },
    { v: image[y1 * TILE_DIM + x0], w: (1 - fx) * fy },
    { v: image[y1 * TILE_DIM + x1], w: fx * fy },
  ];

  let wSum = 0;
  let vSum = 0;
  for (const c of corners) {
    if (Number.isFinite(c.v)) {
      wSum += c.w;
      vSum += c.v * c.w;
    }
  }
  return wSum > 0.25 ? vSum / wSum : NaN;
}

function formatFitsCard(str: string): string {
  return str.padEnd(80, ' ').slice(0, 80);
}

function formatFitsFloatCard(key: string, val: number, comment: string): string {
  const lhs = `${key.padEnd(8, ' ')}= ${val.toFixed(10).padStart(20, ' ')}`;
  return formatFitsCard(`${lhs} / ${comment}`);
}

function formatFitsIntCard(key: string, val: number, comment: string): string {
  const lhs = `${key.padEnd(8, ' ')}= ${String(val).padStart(20, ' ')}`;
  return formatFitsCard(`${lhs} / ${comment}`);
}

function formatFitsStringCard(key: string, val: string, comment: string): string {
  const quoted = `'${val.slice(0, 40)}'`;
  const lhs = `${key.padEnd(8, ' ')}= ${quoted.padEnd(20, ' ')}`;
  return formatFitsCard(`${lhs} / ${comment}`);
}

function padCardsToFitsHeader(cards: string[]): Buffer {
  const all = [...cards, formatFitsCard('END')];
  while (all.length % 36 !== 0) {
    all.push(' '.repeat(80));
  }
  return Buffer.from(all.join(''), 'ascii');
}

/**
 * Extracts a genuine RA---TAN / DEC--TAN multi-extension FITS cutout (IMAGE + FLAGS)
 * from a live SPHEREx DR1 Order-5 spectral cube tile centered on (raDeg, decDeg).
 */
export async function extractCubeCutoutFitsBuffer(params: {
  npix: number;
  dir: number;
  plane: number;
  raDeg: number;
  decDeg: number;
  sizeDeg: number;
}): Promise<{ buffer: Buffer; sourceUrl: string }> {
  const { npix, dir, plane, raDeg, decDeg } = params;
  const sizeDeg = Math.min(Math.max(params.sizeDeg, 0.04), 0.3);
  const [{ image, flags, header, sourceUrl }, channels] = await Promise.all([
    fetchTilePlaneData(npix, dir, plane),
    getSpectralChannelsMeta(),
  ]);

  const chMeta = channels.find((c) => c.plane === plane);
  const outDim = 64;
  const scaleDeg = sizeDeg / outDim;
  const cdelt1 = -scaleDeg; // East left
  const cdelt2 = scaleDeg;  // North up
  const crpix1 = (outDim + 1) / 2;
  const crpix2 = (outDim + 1) / 2;

  const outFloats = new Float32Array(outDim * outDim);
  const outFlags = new Int32Array(outDim * outDim);

  for (let oy = 0; oy < outDim; oy++) {
    for (let ox = 0; ox < outDim; ox++) {
      const sky = tanPixelToWorld(ox, oy, raDeg, decDeg, crpix1, crpix2, cdelt1, cdelt2);
      const outIdx = oy * outDim + ox;
      if (!sky) {
        outFloats[outIdx] = NaN;
        outFlags[outIdx] = 1;
        continue;
      }
      const tilePos = hpxSkyToTilePixel(sky.raDeg, sky.decDeg, header);
      if (!tilePos) {
        outFloats[outIdx] = NaN;
        outFlags[outIdx] = 1;
        continue;
      }
      outFloats[outIdx] = sampleTileBilinear(image, tilePos.x, tilePos.y);
      if (flags) {
        const fx = Math.round(tilePos.x);
        const fy = Math.round(tilePos.y);
        outFlags[outIdx] =
          fx >= 0 && fx < TILE_DIM && fy >= 0 && fy < TILE_DIM ? flags[fy * TILE_DIM + fx] : 1;
      }
    }
  }

  const mjdMid = (header.mjdBeg + header.mjdEnd) / 2;
  const primaryCards = [
    formatFitsCard('SIMPLE  =                    T / Conforms to FITS standard'),
    formatFitsIntCard('BITPIX', 8, 'Array data type'),
    formatFitsIntCard('NAXIS', 0, 'No primary data array'),
    formatFitsCard('EXTEND  =                    T / Extensions follow'),
    formatFitsStringCard('TELESCOP', 'SPHEREx', 'NASA SPHEREx Mission'),
    formatFitsStringCard('INSTRUME', 'SPHEREx', 'All-Sky DR1 Spectral Cube'),
    formatFitsStringCard('ORIGIN', 'NASA/IPAC IRSA', 'Order-5 HiPS DR1 Spectral Cube'),
    formatFitsIntCard('NPIX', npix, 'HEALPix NESTED Order-5 tile'),
    formatFitsIntCard('CHANNEL', plane, 'Spectral cube plane (1..102)'),
  ];
  const primaryHdr = padCardsToFitsHeader(primaryCards);

  const sharedWcsCards = [
    formatFitsStringCard('BUNIT', 'MJy / sr', 'Calibrated surface brightness'),
    formatFitsStringCard('CTYPE1', 'RA---TAN', 'Gnomonic projection'),
    formatFitsStringCard('CTYPE2', 'DEC--TAN', 'Gnomonic projection'),
    formatFitsFloatCard('CRVAL1', raDeg, 'Reference RA (deg)'),
    formatFitsFloatCard('CRVAL2', decDeg, 'Reference Dec (deg)'),
    formatFitsFloatCard('CRPIX1', crpix1, 'Reference X pixel'),
    formatFitsFloatCard('CRPIX2', crpix2, 'Reference Y pixel'),
    formatFitsFloatCard('CDELT1', cdelt1, 'Degrees/pixel along RA'),
    formatFitsFloatCard('CDELT2', cdelt2, 'Degrees/pixel along Dec'),
    formatFitsFloatCard('PC1_1', 1.0, 'TAN rotation matrix'),
    formatFitsFloatCard('PC1_2', 0.0, 'TAN rotation matrix'),
    formatFitsFloatCard('PC2_1', 0.0, 'TAN rotation matrix'),
    formatFitsFloatCard('PC2_2', 1.0, 'TAN rotation matrix'),
    formatFitsFloatCard('EQUINOX', 2000.0, 'ICRS J2000'),
    formatFitsStringCard('RADESYS', 'ICRS', 'Equatorial reference frame'),
    formatFitsStringCard('DATE-OBS', `${header.dateBeg.slice(0, 10)}..${header.dateEnd.slice(0, 10)}`, 'DR1 survey window'),
    formatFitsFloatCard('MJD-OBS', mjdMid, 'Midpoint MJD of DR1 cube'),
    formatFitsIntCard('DETECTOR', chMeta?.detector ?? 4, 'SPHEREx detector array (1-6)'),
    formatFitsFloatCard('WAVELEN', chMeta?.lambdaEffUm ?? 3.0, 'Effective wavelength (um)'),
    formatFitsStringCard('HIERARCH SPS_FLAGS', 'DR1-CUBE', 'SPHEREx DR1 Order-5 mosaic'),
  ];

  const imageHdr = padCardsToFitsHeader([
    formatFitsCard("XTENSION= 'IMAGE   '           / Science surface brightness"),
    formatFitsIntCard('BITPIX', -32, 'IEEE 32-bit float'),
    formatFitsIntCard('NAXIS', 2, '2D sky cutout'),
    formatFitsIntCard('NAXIS1', outDim, 'Width in pixels'),
    formatFitsIntCard('NAXIS2', outDim, 'Height in pixels'),
    formatFitsIntCard('PCOUNT', 0, 'Parameter count'),
    formatFitsIntCard('GCOUNT', 1, 'Group count'),
    formatFitsStringCard('EXTNAME', 'IMAGE', 'Extension name'),
    ...sharedWcsCards,
  ]);

  const dataByteLen = outDim * outDim * 4;
  const paddedDataLen = Math.ceil(dataByteLen / 2880) * 2880;
  const imageDataBuf = Buffer.alloc(paddedDataLen);
  for (let i = 0; i < outFloats.length; i++) {
    imageDataBuf.writeFloatBE(outFloats[i], i * 4);
  }

  const flagsHdr = padCardsToFitsHeader([
    formatFitsCard("XTENSION= 'IMAGE   '           / Quality flags"),
    formatFitsIntCard('BITPIX', 32, '32-bit signed integer'),
    formatFitsIntCard('NAXIS', 2, '2D mask'),
    formatFitsIntCard('NAXIS1', outDim, 'Width in pixels'),
    formatFitsIntCard('NAXIS2', outDim, 'Height in pixels'),
    formatFitsIntCard('PCOUNT', 0, 'Parameter count'),
    formatFitsIntCard('GCOUNT', 1, 'Group count'),
    formatFitsStringCard('EXTNAME', 'FLAGS', 'Extension name'),
  ]);
  const flagsDataBuf = Buffer.alloc(paddedDataLen);
  for (let i = 0; i < outFlags.length; i++) {
    flagsDataBuf.writeInt32BE(outFlags[i], i * 4);
  }

  return {
    buffer: Buffer.concat([primaryHdr, imageHdr, imageDataBuf, flagsHdr, flagsDataBuf]),
    sourceUrl,
  };
}

// Curated spectral planes spanning all 6 detectors (D1-D6), avoiding blank channels D3:17 (51) and D4:01 (52)
const CURATED_PLANES = [
  2, 8, 15,        // D1 (0.77 - 1.06 um)
  19, 25, 32,      // D2 (1.13 - 1.56 um)
  36, 42, 49,      // D3 (1.68 - 2.30 um)
  54, 57, 60, 63, 67, // D4 (2.56 - 3.70 um, 5 channels for multi-band diff & default view)
  70, 77, 83,      // D5 (3.87 - 4.35 um)
  87, 94, 100,     // D6 (4.47 - 4.92 um)
];

export async function querySpherexCubeObservations(params: {
  raDeg: number;
  decDeg: number;
  radiusDeg: number;
  collection: string;
  resolvedName?: string;
  upstreamError?: string;
}): Promise<ObservationsSearchResponse> {
  const { raDeg, decDeg, radiusDeg, collection, resolvedName, upstreamError } = params;
  const { npix, dir } = ang2pixNest32(raDeg, decDeg);
  const [header, channels] = await Promise.all([
    fetchCubeHeaderInfo(npix, dir),
    getSpectralChannelsMeta(),
  ]);

  const baseUrls = getCubeTileMirrorUrls(npix, dir);
  const raHms = formatRaHmsLocal(raDeg);
  const decDms = formatDecDmsLocal(decDeg);

  // Compute small sky bounding box polygon around target for Aladin footprint overlay
  const dDec = Math.max(radiusDeg, 0.08);
  const dRa = dDec / Math.max(0.2, Math.cos((decDeg * Math.PI) / 180));
  const polygon = [
    [raDeg - dRa, decDeg - dDec],
    [raDeg + dRa, decDeg - dDec],
    [raDeg + dRa, decDeg + dDec],
    [raDeg - dRa, decDeg + dDec],
  ];

  const observations: SpherexObservation[] = [];

  for (const plane of CURATED_PLANES) {
    const ch = channels.find((c) => c.plane === plane);
    if (!ch) continue;
    const chTag = `D${ch.detector}:${String(ch.channelInDetector).padStart(2, '0')}`;
    if (header.blankChannels.has(chTag)) continue;

    const bandpassName = `SPHEREx-D${ch.detector}`;
    const obsId = `SPHEREx-DR1-HPX${npix}-CH${String(plane).padStart(3, '0')}`;

    observations.push({
      id: `${obsId}-D${ch.detector}`,
      obsId,
      publisherDid: `ivo://IPAC/P/SPHEREx/DR1/cube#Npix${npix}/ch${plane}`,
      collection: 'spherex_dr1_allsky_cube',
      bandpassName,
      detectorNumber: ch.detector,
      emMinUm: Number(ch.lambdaMinUm.toFixed(4)),
      emMaxUm: Number(ch.lambdaMaxUm.toFixed(4)),
      emCenterUm: Number(ch.lambdaEffUm.toFixed(4)),
      emResPower: Math.round(ch.resPower),
      raDeg,
      decDeg,
      raHms,
      decDms,
      tMinMjd: header.mjdBeg,
      tMaxMjd: header.mjdEnd,
      obsDateIso: header.dateBeg,
      obsDateDisplay: `${header.dateBeg.slice(0, 10)} – ${header.dateEnd.slice(0, 10)} · Ch ${plane} (${ch.lambdaEffUm.toFixed(2)} µm)`,
      exposureSec: null,
      pixelScaleArcsec: 12.88,
      fovDeg: 1.83,
      widthPx: 64,
      heightPx: 64,
      regionPolygon: polygon,
      targetName: resolvedName || `Tile Npix${npix}`,
      calibLevel: 3,
      accessUrl: `${baseUrls[0]}?plane=${plane}`,
      accessSizeKb: 1024,
      spectralChannel: plane,
      dataSource: 'NASA/IPAC SPHEREx DR1 Cube (IRSA/S3)',
    });
  }

  return {
    query: {
      raDeg,
      decDeg,
      raHms,
      decDms,
      radiusDeg,
      collection,
      resolvedName,
    },
    sourceStatus: observations.length > 0 ? 'live-cube-fallback' : 'empty',
    upstreamError,
    noticeMessage:
      'NASA/IPAC IRSA SIA2 exposure query is temporarily returning HTTP 502 upstream. Automatically displaying real SPHEREx DR1 All-Sky Spectral Cube data (IRSA / AWS Open Data S3) across bands D1–D6.',
    totalCount: observations.length,
    observations,
  };
}
