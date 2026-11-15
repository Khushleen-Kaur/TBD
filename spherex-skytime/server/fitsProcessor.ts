import zlib from 'node:zlib';
import {
  extractCubeCutoutFitsBuffer,
  parseCubeAccessUrl,
} from './spherexCube.ts';
import type {
  FitsDiffHotspot,
  FitsDiffResponse,
  FitsHeaderSummary,
  FitsInspectResponse,
  FitsPhotometrySummary,
  FitsStats,
} from '../src/types/spherex.ts';

interface ParsedHdu {
  extname: string;
  bitpix: number;
  naxis: number;
  dims: number[];
  cards: string[];
  headerMap: Map<string, string>;
  dataOffset: number;
  dataBytes: number;
}

interface CachedFits {
  buffer: Buffer;
  hdus: ParsedHdu[];
  fetchedAt: number;
}

export const PER_OBSERVATION_TIMEOUT_MS = 30_000;

const fitsCache = new Map<string, CachedFits>();
const inspectCache = new Map<string, FitsInspectResponse>();
const inFlightFetches = new Map<string, Promise<{ cached: CachedFits; cutoutUrl: string }>>();
const MAX_FITS_CACHE = 300;
const MAX_INSPECT_CACHE = 400;

export class FitsValidationError extends Error {
  readonly code: 'INVALID_URL' | 'HTTP_ERROR' | 'HTML_RESPONSE' | 'INVALID_FITS' | 'TIMEOUT';
  readonly retryable: boolean;

  constructor(
    message: string,
    code: 'INVALID_URL' | 'HTTP_ERROR' | 'HTML_RESPONSE' | 'INVALID_FITS' | 'TIMEOUT',
    retryable = false
  ) {
    super(message);
    this.name = 'FitsValidationError';
    this.code = code;
    this.retryable = retryable;
  }
}

function isAllowedIrsaUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return (
      u.protocol === 'https:' &&
      (u.hostname.endsWith('irsa.ipac.caltech.edu') ||
        u.hostname === 'nasa-irsa-spherex.s3.amazonaws.com')
    );
  } catch {
    return false;
  }
}

function parseHeaderCard(card: string): { key: string; value: string } | null {
  if (card.startsWith('COMMENT') || card.startsWith('HISTORY') || card.startsWith('END     ')) {
    return null;
  }
  if (card.startsWith('HIERARCH ')) {
    const eqIdx = card.indexOf('=');
    if (eqIdx === -1) return null;
    const key = card.slice(0, eqIdx).trim();
    let valPart = card.slice(eqIdx + 1);
    const slashIdx = valPart.indexOf('/');
    if (slashIdx !== -1 && !valPart.trim().startsWith("'")) {
      valPart = valPart.slice(0, slashIdx);
    }
    return { key, value: valPart.trim().replace(/^'|'$/g, '').trim() };
  }
  if (card[8] === '=' && card[9] === ' ') {
    const key = card.slice(0, 8).trim();
    let valPart = card.slice(10);
    if (valPart.trim().startsWith("'")) {
      const m = valPart.match(/'([^']*)'/);
      return { key, value: m ? m[1].trim() : '' };
    }
    const slashIdx = valPart.indexOf('/');
    if (slashIdx !== -1) valPart = valPart.slice(0, slashIdx);
    return { key, value: valPart.trim() };
  }
  return null;
}

export function parseFitsHdus(buf: Buffer): ParsedHdu[] {
  const hdus: ParsedHdu[] = [];
  let offset = 0;

  while (offset + 2880 <= buf.length) {
    const cards: string[] = [];
    const headerMap = new Map<string, string>();
    let foundEnd = false;

    while (offset + 2880 <= buf.length) {
      const block = buf.subarray(offset, offset + 2880).toString('ascii');
      offset += 2880;
      for (let i = 0; i < 36; i++) {
        const card = block.slice(i * 80, (i + 1) * 80);
        cards.push(card);
        const parsed = parseHeaderCard(card);
        if (parsed) headerMap.set(parsed.key, parsed.value);
        if (card.startsWith('END     ')) {
          foundEnd = true;
          break;
        }
      }
      if (foundEnd) break;
    }

    if (!foundEnd) break;

    const bitpix = Number(headerMap.get('BITPIX') || 0);
    const naxis = Number(headerMap.get('NAXIS') || 0);
    const dims: number[] = [];
    for (let a = 1; a <= naxis; a++) {
      dims.push(Number(headerMap.get(`NAXIS${a}`) || 0));
    }
    const pcount = Number(headerMap.get('PCOUNT') || 0);
    const gcount = Number(headerMap.get('GCOUNT') || 1);

    let dataBytes = 0;
    if (naxis > 0) {
      const npix = dims.reduce((acc, d) => acc * d, 1);
      dataBytes = (Math.abs(bitpix) / 8) * gcount * (pcount + npix);
    }

    const extname = headerMap.get('EXTNAME') || (hdus.length === 0 ? 'PRIMARY' : `HDU_${hdus.length}`);
    hdus.push({
      extname,
      bitpix,
      naxis,
      dims,
      cards,
      headerMap,
      dataOffset: offset,
      dataBytes,
    });

    const padded = Math.ceil(dataBytes / 2880) * 2880;
    offset += padded;
  }

  return hdus;
}

function readFloat32Array(buf: Buffer, hdu: ParsedHdu): Float32Array {
  const count = hdu.dims[0] * hdu.dims[1];
  if (hdu.dataOffset + count * 4 > buf.length) {
    throw new FitsValidationError(
      'FITS IMAGE HDU data section is truncated or incomplete.',
      'INVALID_FITS',
      true
    );
  }
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readFloatBE(hdu.dataOffset + i * 4);
  }
  return out;
}

function readInt32Array(buf: Buffer, hdu: ParsedHdu): Int32Array {
  const count = hdu.dims[0] * hdu.dims[1];
  if (hdu.dataOffset + count * 4 > buf.length) {
    throw new FitsValidationError(
      'FITS FLAGS HDU data section is truncated or incomplete.',
      'INVALID_FITS',
      true
    );
  }
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readInt32BE(hdu.dataOffset + i * 4);
  }
  return out;
}

export function validateFitsResponseAndParse(
  status: number,
  contentType: string,
  buffer: Buffer
): ParsedHdu[] {
  if (status < 200 || status >= 300) {
    const retryable = [429, 500, 502, 503, 504].includes(status);
    throw new FitsValidationError(
      `IRSA cutout service returned HTTP ${status}.`,
      'HTTP_ERROR',
      retryable
    );
  }

  const ct = contentType.toLowerCase();
  const textPrefix = buffer.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
  if (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    textPrefix.startsWith('<!doctype') ||
    textPrefix.startsWith('<html')
  ) {
    throw new FitsValidationError(
      'Archive returned an HTML page instead of FITS observation data.',
      'HTML_RESPONSE',
      true
    );
  }

  if (ct.includes('application/json') || textPrefix.startsWith('{')) {
    throw new FitsValidationError(
      'Archive returned JSON text instead of binary FITS data.',
      'INVALID_FITS',
      false
    );
  }

  const magic = buffer.subarray(0, 9).toString('ascii');
  if (buffer.length < 2880 || !magic.startsWith('SIMPLE  =')) {
    throw new FitsValidationError(
      'Response payload is missing a valid FITS SIMPLE header.',
      'INVALID_FITS',
      false
    );
  }

  const hdus = parseFitsHdus(buffer);
  const imageHdu =
    hdus.find((h) => h.extname === 'IMAGE' && h.naxis === 2) ||
    hdus.find((h) => h.naxis === 2);

  if (!imageHdu || imageHdu.dims[0] <= 0 || imageHdu.dims[1] <= 0) {
    throw new FitsValidationError(
      'FITS file does not contain a valid 2D science IMAGE extension.',
      'INVALID_FITS',
      false
    );
  }

  if (imageHdu.dataOffset + imageHdu.dataBytes > buffer.length) {
    throw new FitsValidationError(
      'FITS IMAGE extension bytes are truncated.',
      'INVALID_FITS',
      true
    );
  }

  return hdus;
}

async function fetchFitsWithBudget(url: string, budgetMs = PER_OBSERVATION_TIMEOUT_MS): Promise<{
  buffer: Buffer;
  hdus: ParsedHdu[];
}> {
  const deadline = Date.now() + budgetMs;
  let lastError: FitsValidationError | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) {
      throw new FitsValidationError(
        'Observation retrieval exceeded the 30-second timeout.',
        'TIMEOUT',
        false
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      const contentType = resp.headers.get('content-type') || '';
      const buffer = Buffer.from(await resp.arrayBuffer());
      clearTimeout(timer);

      const hdus = validateFitsResponseAndParse(resp.status, contentType, buffer);
      return { buffer, hdus };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof FitsValidationError) {
        lastError = err;
        if (err.retryable && attempt < 2 && deadline - Date.now() > 2000) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        throw err;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new FitsValidationError(
          'Observation retrieval timed out after 30 seconds.',
          'TIMEOUT',
          false
        );
      }
      lastError = new FitsValidationError(
        err instanceof Error ? err.message : 'Network error fetching FITS cutout.',
        'HTTP_ERROR',
        true
      );
      if (attempt < 2 && deadline - Date.now() > 2000) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw lastError;
    }
  }

  throw (
    lastError ||
    new FitsValidationError('Failed to fetch valid FITS cutout from IRSA.', 'HTTP_ERROR', false)
  );
}

export async function fetchCutoutFits(
  accessUrl: string,
  raDeg: number,
  decDeg: number,
  sizeDeg = 0.08
): Promise<{ cached: CachedFits; cutoutUrl: string }> {
  if (!isAllowedIrsaUrl(accessUrl)) {
    throw new FitsValidationError(
      'Only official NASA/IPAC IRSA FITS URLs are permitted.',
      'INVALID_URL',
      false
    );
  }

  const clampedSize = Math.min(Math.max(sizeDeg, 0.02), 0.3);
  const cubeSpec = parseCubeAccessUrl(accessUrl);
  const cutoutUrl = cubeSpec
    ? `${accessUrl}&ra=${raDeg.toFixed(6)}&dec=${decDeg.toFixed(6)}&size=${clampedSize.toFixed(4)}`
    : `${accessUrl}?center=${raDeg.toFixed(6)},${decDeg.toFixed(6)}&size=${clampedSize.toFixed(4)}`;

  const existing = fitsCache.get(cutoutUrl);
  if (existing) {
    return { cached: existing, cutoutUrl };
  }

  const inflight = inFlightFetches.get(cutoutUrl);
  if (inflight) {
    return inflight;
  }

  const task = (async () => {
    let buffer: Buffer;
    let hdus: ParsedHdu[];

    if (cubeSpec) {
      const extracted = await extractCubeCutoutFitsBuffer({
        npix: cubeSpec.npix,
        dir: cubeSpec.dir,
        plane: cubeSpec.plane,
        raDeg,
        decDeg,
        sizeDeg: Math.max(clampedSize, 0.14),
      });
      buffer = extracted.buffer;
      hdus = parseFitsHdus(buffer);
    } else {
      const fetched = await fetchFitsWithBudget(cutoutUrl, PER_OBSERVATION_TIMEOUT_MS);
      buffer = fetched.buffer;
      hdus = fetched.hdus;
    }

    if (fitsCache.size >= MAX_FITS_CACHE) {
      const oldestKey = fitsCache.keys().next().value;
      if (oldestKey) fitsCache.delete(oldestKey);
    }
    const entry: CachedFits = { buffer, hdus, fetchedAt: Date.now() };
    fitsCache.set(cutoutUrl, entry);
    return { cached: entry, cutoutUrl };
  })();

  inFlightFetches.set(cutoutUrl, task);
  try {
    return await task;
  } finally {
    inFlightFetches.delete(cutoutUrl);
  }
}

export async function buildSingleImageFits(
  accessUrl: string,
  raDeg: number,
  decDeg: number,
  sizeDeg = 0.08
): Promise<Buffer> {
  const { cached } = await fetchCutoutFits(accessUrl, raDeg, decDeg, sizeDeg);
  const imageHdu =
    cached.hdus.find((h) => h.extname === 'IMAGE') || cached.hdus.find((h) => h.naxis === 2);
  if (!imageHdu) {
    throw new FitsValidationError(
      'No 2D science IMAGE extension found in FITS cutout.',
      'INVALID_FITS',
      false
    );
  }

  const keepKeys = new Set([
    'BITPIX',
    'NAXIS',
    'NAXIS1',
    'NAXIS2',
    'BUNIT',
    'CTYPE1',
    'CTYPE2',
    'CRVAL1',
    'CRVAL2',
    'CRPIX1',
    'CRPIX2',
    'PC1_1',
    'PC1_2',
    'PC2_1',
    'PC2_2',
    'CD1_1',
    'CD1_2',
    'CD2_1',
    'CD2_2',
    'CDELT1',
    'CDELT2',
    'EQUINOX',
    'RADESYS',
    'DATE-OBS',
    'MJD-OBS',
    'DETECTOR',
  ]);

  const outCards: string[] = [];
  const formatCard = (str: string) => str.padEnd(80, ' ').slice(0, 80);
  outCards.push(formatCard('SIMPLE  =                    T / Standard FITS primary image extracted from MEF'));

  for (const card of imageHdu.cards) {
    const key = card.slice(0, 8).trim();
    if (keepKeys.has(key)) {
      outCards.push(formatCard(card));
    }
  }
  outCards.push(formatCard('END'));

  while (outCards.length % 36 !== 0) {
    outCards.push(' '.repeat(80));
  }

  const headerBuf = Buffer.from(outCards.join(''), 'ascii');
  const rawImageBuf = cached.buffer.subarray(
    imageHdu.dataOffset,
    imageHdu.dataOffset + imageHdu.dataBytes
  );
  const paddedDataLen = Math.ceil(rawImageBuf.length / 2880) * 2880;
  const dataBuf = Buffer.alloc(paddedDataLen);
  rawImageBuf.copy(dataBuf);

  return Buffer.concat([headerBuf, dataBuf]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), rowStart + 1);
  }

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function applyColormap(
  t: number,
  colormap: 'infrared' | 'viridis' | 'grayscale' | 'cool'
): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  if (colormap === 'grayscale') {
    const v = Math.round(x * 255);
    return [v, v, v];
  }
  if (colormap === 'cool') {
    const r = Math.round(255 * Math.pow(x, 2.1));
    const g = Math.round(255 * (0.12 + 0.88 * Math.pow(x, 1.15)));
    const b = Math.round(255 * (0.22 + 0.78 * Math.pow(x, 0.7)));
    return [Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }
  if (colormap === 'viridis') {
    const r = Math.round(255 * Math.min(1, Math.max(0, -0.35 + 1.35 * x * x)));
    const g = Math.round(255 * Math.min(1, Math.max(0, 0.05 + 0.9 * Math.pow(x, 0.85))));
    const b = Math.round(
      255 * Math.min(1, Math.max(0, 0.35 + 0.45 * Math.sin(x * Math.PI * 0.85)))
    );
    return [r, g, b];
  }
  if (x < 0.25) {
    const u = x / 0.25;
    return [Math.round(8 + u * 26), Math.round(14 + u * 22), Math.round(32 + u * 54)];
  }
  if (x < 0.6) {
    const u = (x - 0.25) / 0.35;
    return [Math.round(34 + u * 165), Math.round(36 + u * 58), Math.round(86 - u * 42)];
  }
  if (x < 0.88) {
    const u = (x - 0.6) / 0.28;
    return [Math.round(199 + u * 52), Math.round(94 + u * 115), Math.round(44 + u * 40)];
  }
  const u = (x - 0.88) / 0.12;
  return [Math.round(251 + u * 4), Math.round(209 + u * 46), Math.round(84 + u * 171)];
}

function worldToPixel(
  raDeg: number,
  decDeg: number,
  crval1: number,
  crval2: number,
  crpix1: number,
  crpix2: number,
  pc: [number, number, number, number]
): { x: number; y: number } | null {
  const deg2rad = Math.PI / 180;
  const alpha = raDeg * deg2rad;
  const delta = decDeg * deg2rad;
  const alpha0 = crval1 * deg2rad;
  const delta0 = crval2 * deg2rad;

  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);
  const cosD0 = Math.cos(delta0);
  const sinD0 = Math.sin(delta0);
  const dAlpha = alpha - alpha0;

  const denom = sinD * sinD0 + cosD * cosD0 * Math.cos(dAlpha);
  if (denom <= 0) return null;

  const xiDeg = (cosD * Math.sin(dAlpha)) / denom / deg2rad;
  const etaDeg = (sinD * cosD0 - cosD * sinD0 * Math.cos(dAlpha)) / denom / deg2rad;

  const [pc11, pc12, pc21, pc22] = pc;
  const det = pc11 * pc22 - pc12 * pc21;
  if (Math.abs(det) < 1e-18) return null;

  const dx = (pc22 * xiDeg - pc12 * etaDeg) / det;
  const dy = (-pc21 * xiDeg + pc11 * etaDeg) / det;

  return {
    x: crpix1 - 1 + dx,
    y: crpix2 - 1 + dy,
  };
}

export async function inspectAndRenderFits(params: {
  accessUrl: string;
  raDeg: number;
  decDeg: number;
  sizeDeg?: number;
  stretch?: 'asinh' | 'log' | 'linear';
  subtractZodi?: boolean;
  colormap?: 'infrared' | 'viridis' | 'grayscale' | 'cool';
}): Promise<FitsInspectResponse> {
  const stretch = params.stretch || 'asinh';
  const subtractZodi = params.subtractZodi ?? true;
  const colormap = params.colormap || 'infrared';
  const sizeDeg = params.sizeDeg ?? 0.08;

  const inspectKey = `${params.accessUrl}|${params.raDeg.toFixed(5)}|${params.decDeg.toFixed(5)}|${sizeDeg}|${stretch}|${subtractZodi}|${colormap}`;
  const cachedResp = inspectCache.get(inspectKey);
  if (cachedResp) {
    return cachedResp;
  }

  const { cached, cutoutUrl } = await fetchCutoutFits(
    params.accessUrl,
    params.raDeg,
    params.decDeg,
    sizeDeg
  );

  const imageHdu =
    cached.hdus.find((h) => h.extname === 'IMAGE' && h.naxis === 2) ||
    cached.hdus.find((h) => h.naxis === 2);

  if (!imageHdu || imageHdu.naxis !== 2) {
    throw new FitsValidationError(
      'Could not locate 2D IMAGE HDU in SPHEREx MEF file.',
      'INVALID_FITS',
      false
    );
  }

  const width = imageHdu.dims[0];
  const height = imageHdu.dims[1];
  const imageArr = readFloat32Array(cached.buffer, imageHdu);

  const zodiHdu = cached.hdus.find((h) => h.extname === 'ZODI');
  const zodiArr =
    zodiHdu && zodiHdu.dims[0] === width && zodiHdu.dims[1] === height
      ? readFloat32Array(cached.buffer, zodiHdu)
      : null;

  const varHdu = cached.hdus.find((h) => h.extname === 'VARIANCE');
  const varArr =
    varHdu && varHdu.dims[0] === width && varHdu.dims[1] === height
      ? readFloat32Array(cached.buffer, varHdu)
      : null;

  const flagsHdu = cached.hdus.find((h) => h.extname === 'FLAGS');
  const flagsArr =
    flagsHdu && flagsHdu.dims[0] === width && flagsHdu.dims[1] === height
      ? readInt32Array(cached.buffer, flagsHdu)
      : null;

  const signal = new Float32Array(width * height);
  const validValues: number[] = [];
  let flaggedPixels = 0;

  for (let i = 0; i < width * height; i++) {
    const raw = imageArr[i];
    const z = zodiArr ? zodiArr[i] : 0;
    const val = subtractZodi && zodiArr && Number.isFinite(z) ? raw - z : raw;
    const flagVal = flagsArr ? flagsArr[i] : 0;
    if (flagVal !== 0) flaggedPixels++;

    signal[i] = val;
    if (Number.isFinite(val)) {
      validValues.push(val);
    }
  }

  if (validValues.length === 0) {
    throw new FitsValidationError(
      'SPHEREx science image contains no valid finite pixels.',
      'INVALID_FITS',
      false
    );
  }

  const sorted = [...validValues].sort((a, b) => a - b);
  const quantile = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

  const p1 = quantile(0.02);
  const median = quantile(0.5);
  const p99 = quantile(0.992);
  const minVal = sorted[0];
  const maxVal = sorted[sorted.length - 1];

  const scale = Math.max(1, Math.min(6, Math.floor(320 / Math.max(width, height))));
  const outW = width * scale;
  const outH = height * scale;
  const rgb = new Uint8Array(outW * outH * 3);

  const low = p1;
  const high = Math.max(p99, low + 1e-6);
  const span = high - low;

  for (let py = 0; py < height; py++) {
    const pngBaseY = (height - 1 - py) * scale;
    for (let px = 0; px < width; px++) {
      const val = signal[py * width + px];
      let norm = 0;
      if (Number.isFinite(val)) {
        const linear = Math.min(1, Math.max(0, (val - low) / span));
        if (stretch === 'linear') {
          norm = linear;
        } else if (stretch === 'log') {
          norm = Math.log10(1 + 99 * linear) / Math.log10(100);
        } else {
          const softness = 0.08;
          norm = Math.asinh(linear / softness) / Math.asinh(1 / softness);
        }
      }
      const [r, g, b] = applyColormap(norm, colormap);
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const idx = ((pngBaseY + sy) * outW + (px * scale + sx)) * 3;
          rgb[idx] = r;
          rgb[idx + 1] = g;
          rgb[idx + 2] = b;
        }
      }
    }
  }

  const pngBuf = encodeRgbPng(outW, outH, rgb);
  const pngDataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;

  const hm = imageHdu.headerMap;
  const crval1 = hm.has('CRVAL1') ? Number(hm.get('CRVAL1')) : null;
  const crval2 = hm.has('CRVAL2') ? Number(hm.get('CRVAL2')) : null;
  const crpix1 = hm.has('CRPIX1') ? Number(hm.get('CRPIX1')) : null;
  const crpix2 = hm.has('CRPIX2') ? Number(hm.get('CRPIX2')) : null;
  const pc11 = hm.has('PC1_1') ? Number(hm.get('PC1_1')) : null;
  const pc12 = hm.has('PC1_2') ? Number(hm.get('PC1_2')) : null;
  const pc21 = hm.has('PC2_1') ? Number(hm.get('PC2_1')) : null;
  const pc22 = hm.has('PC2_2') ? Number(hm.get('PC2_2')) : null;
  const pcMatrix: [number, number, number, number] | null =
    pc11 !== null && pc12 !== null && pc21 !== null && pc22 !== null
      ? [pc11, pc12, pc21, pc22]
      : null;

  const headers: FitsHeaderSummary = {
    dateObs: hm.get('DATE-OBS') || null,
    mjdObs: hm.has('MJD-OBS') ? Number(hm.get('MJD-OBS')) : null,
    mjdAvg: hm.has('MJD-AVG') ? Number(hm.get('MJD-AVG')) : null,
    detector: hm.has('DETECTOR') ? Number(hm.get('DETECTOR')) : null,
    bunit: hm.get('BUNIT') || 'MJy / sr',
    spsFlags: hm.get('HIERARCH SPS_FLAGS') || null,
    obsInSband: hm.get('HIERARCH OBS_IN_SBAND') || null,
    minGcd2SaaDeg: hm.has('HIERARCH SGT_MIN_GCD2SAA')
      ? Number(hm.get('HIERARCH SGT_MIN_GCD2SAA'))
      : null,
    ctype1: hm.get('CTYPE1') || null,
    ctype2: hm.get('CTYPE2') || null,
    crval1,
    crval2,
    crpix1,
    crpix2,
    pcMatrix,
    hduNames: cached.hdus.map((h) => h.extname),
  };

  let targetPixelX: number | null = null;
  let targetPixelY: number | null = null;
  if (crval1 !== null && crval2 !== null && crpix1 !== null && crpix2 !== null && pcMatrix) {
    const pxPos = worldToPixel(params.raDeg, params.decDeg, crval1, crval2, crpix1, crpix2, pcMatrix);
    if (pxPos && pxPos.x >= 0 && pxPos.x < width && pxPos.y >= 0 && pxPos.y < height) {
      targetPixelX = Number(pxPos.x.toFixed(2));
      targetPixelY = Number(pxPos.y.toFixed(2));
    }
  }

  const cx = targetPixelX !== null ? targetPixelX : width / 2;
  const cy = targetPixelY !== null ? targetPixelY : height / 2;
  const apRadius = 2.0;

  let peak = -Infinity;
  let sumRaw = 0;
  let sumZodi = 0;
  let sumVar = 0;
  let apCount = 0;
  let varCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= apRadius) {
        const idx = y * width + x;
        const val = imageArr[idx];
        const isFlagged = flagsArr ? flagsArr[idx] !== 0 : false;
        if (Number.isFinite(val)) {
          if (val > peak) peak = val;
          sumRaw += val;
          sumZodi += zodiArr && Number.isFinite(zodiArr[idx]) ? zodiArr[idx] : 0;
          if (
            varArr &&
            !isFlagged &&
            Number.isFinite(varArr[idx]) &&
            varArr[idx] >= 0 &&
            varArr[idx] < 1e12
          ) {
            sumVar += varArr[idx];
            varCount++;
          }
          apCount++;
        }
      }
    }
  }

  // If core pixels at r=2px are saturated (all NaN), expand to unsaturated PSF wing r=4.5px
  if (apCount === 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist <= 4.5) {
          const idx = y * width + x;
          const val = imageArr[idx];
          const isFlagged = flagsArr ? flagsArr[idx] !== 0 : false;
          if (Number.isFinite(val)) {
            if (val > peak) peak = val;
            sumRaw += val;
            sumZodi += zodiArr && Number.isFinite(zodiArr[idx]) ? zodiArr[idx] : 0;
            if (
              varArr &&
              !isFlagged &&
              Number.isFinite(varArr[idx]) &&
              varArr[idx] >= 0 &&
              varArr[idx] < 1e12
            ) {
              sumVar += varArr[idx];
              varCount++;
            }
            apCount++;
          }
        }
      }
    }
  }

  const meanRaw = apCount > 0 ? sumRaw / apCount : null;
  const meanZodi = apCount > 0 && zodiArr ? sumZodi / apCount : null;
  const netSurfaceBrightness =
    meanRaw !== null && meanZodi !== null ? meanRaw - meanZodi : meanRaw;
  const uncertaintySigma =
    apCount > 0 && varArr && varCount > 0
      ? Math.sqrt(Math.max(0, sumVar * (apCount / varCount))) / apCount
      : null;

  const photometry: FitsPhotometrySummary = {
    targetPixelX,
    targetPixelY,
    apertureRadiusPx: apRadius,
    peakSurfaceBrightness: Number.isFinite(peak) ? Number(peak.toFixed(5)) : null,
    apertureMeanSurfaceBrightness: meanRaw !== null ? Number(meanRaw.toFixed(5)) : null,
    zodiMeanBackground: meanZodi !== null ? Number(meanZodi.toFixed(5)) : null,
    netSurfaceBrightness:
      netSurfaceBrightness !== null ? Number(netSurfaceBrightness.toFixed(5)) : null,
    uncertaintySigma: uncertaintySigma !== null ? Number(uncertaintySigma.toFixed(5)) : null,
    unit: headers.bunit || 'MJy / sr',
    flaggedPixelFraction: Number((flaggedPixels / (width * height)).toFixed(4)),
    note:
      targetPixelX !== null
        ? 'Aperture measured around WCS-projected target coordinate within r = 2 px.'
        : 'Aperture measured around cutout center (WCS target projection fell outside cutout bounds).',
  };

  const stats: FitsStats = {
    width,
    height,
    min: Number(minVal.toFixed(5)),
    max: Number(maxVal.toFixed(5)),
    median: Number(median.toFixed(5)),
    p1: Number(p1.toFixed(5)),
    p99: Number(p99.toFixed(5)),
    validPixels: validValues.length,
    totalPixels: width * height,
    zodiSubtracted: subtractZodi && zodiArr !== null,
    stretch,
    colormap,
  };

  const rawHeaderCards = imageHdu.cards
    .map((c) => c.trimEnd())
    .filter((c) => c.length > 0 && !c.startsWith('END'));

  const result: FitsInspectResponse = {
    dataSource: parseCubeAccessUrl(params.accessUrl)
      ? 'NASA/IPAC SPHEREx DR1 Cube'
      : 'NASA/IPAC IRSA SPHEREx MEF',
    cutoutUrl,
    pngDataUrl,
    headers,
    stats,
    photometry,
    rawHeaderCards,
  };

  if (inspectCache.size >= MAX_INSPECT_CACHE) {
    const oldestKey = inspectCache.keys().next().value;
    if (oldestKey) inspectCache.delete(oldestKey);
  }
  inspectCache.set(inspectKey, result);

  return result;
}

const diffCache = new Map<string, FitsDiffResponse>();
const MAX_DIFF_CACHE = 100;

interface WcsInfo {
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  pc: [number, number, number, number];
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function extractWcs(hm: Map<string, string>): WcsInfo | null {
  const crval1 = hm.has('CRVAL1') ? Number(hm.get('CRVAL1')) : NaN;
  const crval2 = hm.has('CRVAL2') ? Number(hm.get('CRVAL2')) : NaN;
  const crpix1 = hm.has('CRPIX1') ? Number(hm.get('CRPIX1')) : NaN;
  const crpix2 = hm.has('CRPIX2') ? Number(hm.get('CRPIX2')) : NaN;
  if (
    !Number.isFinite(crval1) ||
    !Number.isFinite(crval2) ||
    !Number.isFinite(crpix1) ||
    !Number.isFinite(crpix2)
  ) {
    return null;
  }

  const cdelt1 = hm.has('CDELT1') ? Number(hm.get('CDELT1')) : NaN;
  const cdelt2 = hm.has('CDELT2') ? Number(hm.get('CDELT2')) : NaN;

  if (hm.has('PC1_1') && hm.has('PC1_2') && hm.has('PC2_1') && hm.has('PC2_2')) {
    let pc11 = Number(hm.get('PC1_1'));
    let pc12 = Number(hm.get('PC1_2'));
    let pc21 = Number(hm.get('PC2_1'));
    let pc22 = Number(hm.get('PC2_2'));
    if ([pc11, pc12, pc21, pc22].every(Number.isFinite)) {
      // If PC is a unit rotation matrix and CDELT carries deg/px scale, apply CDELT
      if (
        Number.isFinite(cdelt1) &&
        Number.isFinite(cdelt2) &&
        Math.hypot(pc11, pc12) > 0.1
      ) {
        pc11 *= cdelt1;
        pc12 *= cdelt1;
        pc21 *= cdelt2;
        pc22 *= cdelt2;
      }
      return { crval1, crval2, crpix1, crpix2, pc: [pc11, pc12, pc21, pc22] };
    }
  }

  if (hm.has('CD1_1') && hm.has('CD1_2') && hm.has('CD2_1') && hm.has('CD2_2')) {
    const cd11 = Number(hm.get('CD1_1'));
    const cd12 = Number(hm.get('CD1_2'));
    const cd21 = Number(hm.get('CD2_1'));
    const cd22 = Number(hm.get('CD2_2'));
    if ([cd11, cd12, cd21, cd22].every(Number.isFinite)) {
      return { crval1, crval2, crpix1, crpix2, pc: [cd11, cd12, cd21, cd22] };
    }
  }

  if (Number.isFinite(cdelt1) && Number.isFinite(cdelt2)) {
    return { crval1, crval2, crpix1, crpix2, pc: [cdelt1, 0, 0, cdelt2] };
  }

  return null;
}

function pixelToWorld(x: number, y: number, wcs: WcsInfo): { raDeg: number; decDeg: number } | null {
  const deg2rad = Math.PI / 180;
  const dx = x - (wcs.crpix1 - 1);
  const dy = y - (wcs.crpix2 - 1);
  const [pc11, pc12, pc21, pc22] = wcs.pc;

  const xiDeg = pc11 * dx + pc12 * dy;
  const etaDeg = pc21 * dx + pc22 * dy;
  const xi = xiDeg * deg2rad;
  const eta = etaDeg * deg2rad;

  const alpha0 = wcs.crval1 * deg2rad;
  const delta0 = wcs.crval2 * deg2rad;
  const sinD0 = Math.sin(delta0);
  const cosD0 = Math.cos(delta0);

  const rho = Math.hypot(xi, eta);
  if (rho < 1e-15) {
    return { raDeg: ((wcs.crval1 % 360) + 360) % 360, decDeg: wcs.crval2 };
  }

  const c = Math.atan(rho);
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);

  const sinD = Math.max(-1, Math.min(1, cosC * sinD0 + (eta * sinC * cosD0) / rho));
  const delta = Math.asin(sinD);
  const alpha = alpha0 + Math.atan2(xi * sinC, rho * cosD0 * cosC - eta * sinD0 * sinC);

  const raDeg = (((alpha / deg2rad) % 360) + 360) % 360;
  const decDeg = delta / deg2rad;
  if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) return null;
  return { raDeg, decDeg };
}

interface SignalLayer {
  width: number;
  height: number;
  signal: Float32Array;
  valid: Uint8Array;
  variance: Float32Array | null;
  wcs: WcsInfo | null;
}

function extractSignalLayer(cached: CachedFits, subtractZodi: boolean): SignalLayer {
  const imageHdu =
    cached.hdus.find((h) => h.extname === 'IMAGE' && h.naxis === 2) ||
    cached.hdus.find((h) => h.naxis === 2);

  if (!imageHdu || imageHdu.naxis !== 2) {
    throw new FitsValidationError(
      'Could not locate 2D IMAGE HDU in SPHEREx MEF file.',
      'INVALID_FITS',
      false
    );
  }

  const width = imageHdu.dims[0];
  const height = imageHdu.dims[1];
  const imageArr = readFloat32Array(cached.buffer, imageHdu);

  const zodiHdu = cached.hdus.find((h) => h.extname === 'ZODI');
  const zodiArr =
    zodiHdu && zodiHdu.dims[0] === width && zodiHdu.dims[1] === height
      ? readFloat32Array(cached.buffer, zodiHdu)
      : null;

  const varHdu = cached.hdus.find((h) => h.extname === 'VARIANCE');
  const varArr =
    varHdu && varHdu.dims[0] === width && varHdu.dims[1] === height
      ? readFloat32Array(cached.buffer, varHdu)
      : null;

  const signal = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const raw = imageArr[i];
    const z = zodiArr ? zodiArr[i] : 0;
    const val = subtractZodi && zodiArr && Number.isFinite(z) ? raw - z : raw;
    signal[i] = val;
    valid[i] = Number.isFinite(val) ? 1 : 0;
  }

  return {
    width,
    height,
    signal,
    valid,
    variance: varArr,
    wcs: extractWcs(imageHdu.headerMap),
  };
}

function bilinearSample(
  layer: SignalLayer,
  x: number,
  y: number
): { val: number; varVal: number } | null {
  const { width, height, signal, valid, variance } = layer;
  if (x < -0.5 || x > width - 0.5 || y < -0.5 || y > height - 0.5) return null;

  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const corners = [
    { idx: y0 * width + x0, w: (1 - fx) * (1 - fy) },
    { idx: y0 * width + x1, w: fx * (1 - fy) },
    { idx: y1 * width + x0, w: (1 - fx) * fy },
    { idx: y1 * width + x1, w: fx * fy },
  ];

  let wSum = 0;
  let vSum = 0;
  let varSum = 0;
  let varWeight = 0;

  for (const c of corners) {
    if (valid[c.idx]) {
      wSum += c.w;
      vSum += signal[c.idx] * c.w;
      if (variance) {
        const vv = variance[c.idx];
        if (Number.isFinite(vv) && vv >= 0 && vv < 1e9) {
          varSum += vv * c.w * c.w;
          varWeight += c.w * c.w;
        }
      }
    }
  }

  if (wSum < 0.5) return null;
  return {
    val: vSum / wSum,
    varVal: varWeight > 0 ? varSum / varWeight : 0,
  };
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderContourOverlayRgba(
  width: number,
  height: number,
  mask: Int8Array
): string {
  const scale = Math.max(1, Math.min(6, Math.floor(320 / Math.max(width, height))));
  const outW = width * scale;
  const outH = height * scale;
  const rgba = new Uint8Array(outW * outH * 4);

  for (let py = 0; py < height; py++) {
    const pngBaseY = (height - 1 - py) * scale;
    for (let px = 0; px < width; px++) {
      const cls = mask[py * width + px];
      if (cls === 0) continue;

      const isEdge =
        px === 0 ||
        px === width - 1 ||
        py === 0 ||
        py === height - 1 ||
        mask[py * width + (px - 1)] !== cls ||
        mask[py * width + (px + 1)] !== cls ||
        mask[(py - 1) * width + px] !== cls ||
        mask[(py + 1) * width + px] !== cls;

      // Cyan (#22D3EE) for brighter in A (-1), Rose (#FB7185) for brighter in B (+1)
      const r = cls < 0 ? 34 : 251;
      const g = cls < 0 ? 211 : 113;
      const b = cls < 0 ? 238 : 133;

      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const isSubBorder =
            isEdge &&
            ((px === 0 || mask[py * width + (px - 1)] !== cls ? sx === 0 : false) ||
              (px === width - 1 || mask[py * width + (px + 1)] !== cls ? sx === scale - 1 : false) ||
              (py === 0 || mask[(py - 1) * width + px] !== cls ? sy === scale - 1 : false) ||
              (py === height - 1 || mask[(py + 1) * width + px] !== cls ? sy === 0 : false));

          const alpha = scale === 1 ? (isEdge ? 235 : 85) : isSubBorder ? 245 : 78;
          const idx = ((pngBaseY + sy) * outW + (px * scale + sx)) * 4;
          rgba[idx] = r;
          rgba[idx + 1] = g;
          rgba[idx + 2] = b;
          rgba[idx + 3] = alpha;
        }
      }
    }
  }

  const pngBuf = encodeRgbaPng(outW, outH, rgba);
  return `data:image/png;base64,${pngBuf.toString('base64')}`;
}

export async function computeFitsDifference(params: {
  accessUrlA: string;
  accessUrlB: string;
  raDeg: number;
  decDeg: number;
  sizeDeg?: number;
  subtractZodi?: boolean;
  thresholdSigma?: number;
  matchBackground?: boolean;
  alignMode?: 'wcs' | 'pixel';
}): Promise<FitsDiffResponse> {
  const sizeDeg = params.sizeDeg ?? 0.08;
  const subtractZodi = params.subtractZodi ?? true;
  const thresholdSigma = Math.min(12, Math.max(1.0, params.thresholdSigma ?? 3.0));
  const matchBackground = params.matchBackground ?? true;
  const requestedAlignMode = params.alignMode || 'wcs';

  const cacheKey = [
    params.accessUrlA,
    params.accessUrlB,
    params.raDeg.toFixed(5),
    params.decDeg.toFixed(5),
    sizeDeg,
    subtractZodi,
    thresholdSigma.toFixed(2),
    matchBackground,
    requestedAlignMode,
  ].join('|');

  const cachedDiff = diffCache.get(cacheKey);
  if (cachedDiff) {
    return cachedDiff;
  }

  const [{ cached: cachedA }, { cached: cachedB }] = await Promise.all([
    fetchCutoutFits(params.accessUrlA, params.raDeg, params.decDeg, sizeDeg),
    fetchCutoutFits(params.accessUrlB, params.raDeg, params.decDeg, sizeDeg),
  ]);

  const layerA = extractSignalLayer(cachedA, subtractZodi);
  const layerB = extractSignalLayer(cachedB, subtractZodi);

  const wA = layerA.width;
  const hA = layerA.height;
  const wB = layerB.width;
  const hB = layerB.height;

  const wcsAvailable = Boolean(layerA.wcs && layerB.wcs);
  const alignmentMode: 'wcs' | 'pixel' =
    requestedAlignMode === 'wcs' && wcsAvailable ? 'wcs' : 'pixel';

  const nA = wA * hA;
  const rawDiff = new Float32Array(nA);
  const overlapValid = new Uint8Array(nA);
  const combinedVar = new Float32Array(nA);
  const mappedBx = new Float32Array(nA);
  const mappedBy = new Float32Array(nA);
  const validRawDiffs: number[] = [];

  for (let py = 0; py < hA; py++) {
    for (let px = 0; px < wA; px++) {
      const idx = py * wA + px;
      if (!layerA.valid[idx]) continue;

      let bx = px;
      let by = py;
      if (alignmentMode === 'wcs' && layerA.wcs && layerB.wcs) {
        const sky = pixelToWorld(px, py, layerA.wcs);
        if (!sky) continue;
        const bPos = worldToPixel(
          sky.raDeg,
          sky.decDeg,
          layerB.wcs.crval1,
          layerB.wcs.crval2,
          layerB.wcs.crpix1,
          layerB.wcs.crpix2,
          layerB.wcs.pc
        );
        if (!bPos) continue;
        bx = bPos.x;
        by = bPos.y;
      } else if (wA !== wB || hA !== hB) {
        bx = (px / Math.max(1, wA - 1)) * Math.max(1, wB - 1);
        by = (py / Math.max(1, hA - 1)) * Math.max(1, hB - 1);
      }

      const sampledB = bilinearSample(layerB, bx, by);
      if (!sampledB) continue;

      const d = sampledB.val - layerA.signal[idx];
      if (!Number.isFinite(d)) continue;

      rawDiff[idx] = d;
      overlapValid[idx] = 1;
      mappedBx[idx] = bx;
      mappedBy[idx] = by;

      const varA =
        layerA.variance &&
        Number.isFinite(layerA.variance[idx]) &&
        layerA.variance[idx] >= 0 &&
        layerA.variance[idx] < 1e9
          ? layerA.variance[idx]
          : 0;
      combinedVar[idx] = varA + sampledB.varVal;
      validRawDiffs.push(d);
    }
  }

  const validOverlapPixelCount = validRawDiffs.length;
  const overlapFraction = nA > 0 ? Number((validOverlapPixelCount / nA).toFixed(4)) : 0;

  const medianBackgroundOffset =
    validOverlapPixelCount > 0 ? computeMedian(validRawDiffs) : 0;

  const diffArr = new Float32Array(nA);
  const diffValsForMad: number[] = [];
  for (let i = 0; i < nA; i++) {
    if (!overlapValid[i]) continue;
    const d = matchBackground ? rawDiff[i] - medianBackgroundOffset : rawDiff[i];
    diffArr[i] = d;
    diffValsForMad.push(d);
  }

  const medDiff = diffValsForMad.length > 0 ? computeMedian(diffValsForMad) : 0;
  const absDevs = diffValsForMad.map((v) => Math.abs(v - medDiff));
  const mad = absDevs.length > 0 ? computeMedian(absDevs) : 0;
  const sigmaMad = Math.max(1e-5, 1.4826 * mad);

  const zScores = new Float32Array(nA);
  const maskA = new Int8Array(nA);
  let changedPixelCount = 0;
  let brighterInACount = 0;
  let brighterInBCount = 0;
  let maxAbsDeltaMJySr = 0;

  for (let i = 0; i < nA; i++) {
    if (!overlapValid[i]) continue;
    const d = diffArr[i];
    if (Math.abs(d) > maxAbsDeltaMJySr) maxAbsDeltaMJySr = Math.abs(d);

    const varSig = combinedVar[i] > 0 ? Math.sqrt(combinedVar[i]) : 0;
    const localSigma =
      varSig > 0 ? Math.max(sigmaMad, Math.min(varSig, sigmaMad * 3)) : sigmaMad;
    const z = d / localSigma;
    zScores[i] = z;

    if (z <= -thresholdSigma) {
      maskA[i] = -1;
      changedPixelCount++;
      brighterInACount++;
    } else if (z >= thresholdSigma) {
      maskA[i] = 1;
      changedPixelCount++;
      brighterInBCount++;
    }
  }

  // Map maskA onto Frame B's exact pixel grid so highlighted regions align on Frame B even when rotated/shifted
  const maskB = new Int8Array(wB * hB);
  for (let py = 0; py < hB; py++) {
    for (let px = 0; px < wB; px++) {
      let ax = px;
      let ay = py;
      if (alignmentMode === 'wcs' && layerA.wcs && layerB.wcs) {
        const sky = pixelToWorld(px, py, layerB.wcs);
        if (!sky) continue;
        const aPos = worldToPixel(
          sky.raDeg,
          sky.decDeg,
          layerA.wcs.crval1,
          layerA.wcs.crval2,
          layerA.wcs.crpix1,
          layerA.wcs.crpix2,
          layerA.wcs.pc
        );
        if (!aPos) continue;
        ax = aPos.x;
        ay = aPos.y;
      } else if (wA !== wB || hA !== hB) {
        ax = (px / Math.max(1, wB - 1)) * Math.max(1, wA - 1);
        ay = (py / Math.max(1, hB - 1)) * Math.max(1, hA - 1);
      }

      const rx = Math.round(ax);
      const ry = Math.round(ay);
      if (rx >= 0 && rx < wA && ry >= 0 && ry < hA) {
        maskB[py * wB + px] = maskA[ry * wA + rx];
      }
    }
  }

  const overlayADataUrl = renderContourOverlayRgba(wA, hA, maskA);
  const overlayBDataUrl = renderContourOverlayRgba(wB, hB, maskB);

  // Render aligned Difference Map (B - A) RGB PNG on Frame A's pixel grid
  const scaleA = Math.max(1, Math.min(6, Math.floor(320 / Math.max(wA, hA))));
  const outW = wA * scaleA;
  const outH = hA * scaleA;
  const diffRgb = new Uint8Array(outW * outH * 3);
  const asinhDenom = Math.asinh(Math.max(4, thresholdSigma * 2.5));

  for (let py = 0; py < hA; py++) {
    const pngBaseY = (hA - 1 - py) * scaleA;
    for (let px = 0; px < wA; px++) {
      const idx = py * wA + px;
      let r = 7;
      let g = 11;
      let b = 21;

      if (overlapValid[idx]) {
        const z = zScores[idx];
        const mag = Math.min(1, Math.asinh(Math.abs(z) / 1.4) / asinhDenom);
        if (z < 0) {
          // Brighter in A -> Deep Slate to Cyan (#22D3EE) to White-Cyan
          if (mag < 0.7) {
            const u = mag / 0.7;
            r = Math.round(11 + u * 23);
            g = Math.round(18 + u * 193);
            b = Math.round(34 + u * 204);
          } else {
            const u = (mag - 0.7) / 0.3;
            r = Math.round(34 + u * 175);
            g = Math.round(211 + u * 40);
            b = Math.round(238 + u * 17);
          }
        } else {
          // Brighter in B -> Deep Slate to Rose (#FB7185) to Warm White
          if (mag < 0.7) {
            const u = mag / 0.7;
            r = Math.round(11 + u * 240);
            g = Math.round(18 + u * 95);
            b = Math.round(34 + u * 99);
          } else {
            const u = (mag - 0.7) / 0.3;
            r = Math.round(251 + u * 4);
            g = Math.round(113 + u * 130);
            b = Math.round(133 + u * 90);
          }
        }
      }

      for (let sy = 0; sy < scaleA; sy++) {
        for (let sx = 0; sx < scaleA; sx++) {
          const outIdx = ((pngBaseY + sy) * outW + (px * scaleA + sx)) * 3;
          diffRgb[outIdx] = r;
          diffRgb[outIdx + 1] = g;
          diffRgb[outIdx + 2] = b;
        }
      }
    }
  }

  const diffMapPng = encodeRgbPng(outW, outH, diffRgb);
  const diffMapDataUrl = `data:image/png;base64,${diffMapPng.toString('base64')}`;

  // Extract top 5 connected difference hotspots via BFS
  const visited = new Uint8Array(nA);
  interface RawCluster {
    dominantIn: 'A' | 'B';
    pixelArea: number;
    peakSigma: number;
    peakDeltaMJySr: number;
    sumW: number;
    sumX: number;
    sumY: number;
    sumBx: number;
    sumBy: number;
    score: number;
  }
  const clusters: RawCluster[] = [];

  for (let startY = 0; startY < hA; startY++) {
    for (let startX = 0; startX < wA; startX++) {
      const startIdx = startY * wA + startX;
      const sign = maskA[startIdx];
      if (sign === 0 || visited[startIdx]) continue;

      const queue: number[] = [startIdx];
      visited[startIdx] = 1;
      let head = 0;

      let pixelArea = 0;
      let peakSigma = 0;
      let peakDelta = 0;
      let sumW = 0;
      let sumX = 0;
      let sumY = 0;
      let sumBx = 0;
      let sumBy = 0;

      while (head < queue.length) {
        const curr = queue[head++];
        const cx = curr % wA;
        const cy = Math.floor(curr / wA);
        const absZ = Math.abs(zScores[curr]);
        const d = diffArr[curr];
        const w = Math.max(0.1, absZ);

        pixelArea++;
        if (absZ > peakSigma) {
          peakSigma = absZ;
          peakDelta = d;
        }
        sumW += w;
        sumX += cx * w;
        sumY += cy * w;
        sumBx += mappedBx[curr] * w;
        sumBy += mappedBy[curr] * w;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= wA || ny < 0 || ny >= hA) continue;
            const nIdx = ny * wA + nx;
            if (!visited[nIdx] && maskA[nIdx] === sign) {
              visited[nIdx] = 1;
              queue.push(nIdx);
            }
          }
        }
      }

      clusters.push({
        dominantIn: sign < 0 ? 'A' : 'B',
        pixelArea,
        peakSigma,
        peakDeltaMJySr: peakDelta,
        sumW,
        sumX,
        sumY,
        sumBx,
        sumBy,
        score: peakSigma * Math.sqrt(pixelArea),
      });
    }
  }

  clusters.sort((a, b) => b.score - a.score);
  const hotspots: FitsDiffHotspot[] = clusters.slice(0, 5).map((c, idx) => {
    const xA = Number((c.sumX / c.sumW).toFixed(2));
    const yA = Number((c.sumY / c.sumW).toFixed(2));
    const xB = Number((c.sumBx / c.sumW).toFixed(2));
    const yB = Number((c.sumBy / c.sumW).toFixed(2));
    const sky = layerA.wcs ? pixelToWorld(xA, yA, layerA.wcs) : null;

    return {
      id: idx + 1,
      dominantIn: c.dominantIn,
      pixelArea: c.pixelArea,
      peakSigma: Number(c.peakSigma.toFixed(2)),
      peakDeltaMJySr: Number(c.peakDeltaMJySr.toFixed(5)),
      xA,
      yA,
      xB,
      yB,
      raDeg: sky ? Number(sky.raDeg.toFixed(6)) : null,
      decDeg: sky ? Number(sky.decDeg.toFixed(6)) : null,
    };
  });

  const result: FitsDiffResponse = {
    alignmentMode,
    wcsAvailable,
    overlapFraction,
    thresholdSigma,
    matchBackground,
    medianBackgroundOffset: Number(medianBackgroundOffset.toFixed(5)),
    noiseSigma: Number(sigmaMad.toFixed(5)),
    changedPixelCount,
    validOverlapPixelCount,
    changedFraction:
      validOverlapPixelCount > 0
        ? Number((changedPixelCount / validOverlapPixelCount).toFixed(4))
        : 0,
    brighterInACount,
    brighterInBCount,
    maxAbsDeltaMJySr: Number(maxAbsDeltaMJySr.toFixed(5)),
    widthA: wA,
    heightA: hA,
    widthB: wB,
    heightB: hB,
    overlayADataUrl,
    overlayBDataUrl,
    diffMapDataUrl,
    hotspots,
  };

  if (diffCache.size >= MAX_DIFF_CACHE) {
    const oldestKey = diffCache.keys().next().value;
    if (oldestKey) diffCache.delete(oldestKey);
  }
  diffCache.set(cacheKey, result);

  return result;
}

