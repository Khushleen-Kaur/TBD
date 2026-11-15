export type DetectorBand =
  | 'SPHEREx-D1'
  | 'SPHEREx-D2'
  | 'SPHEREx-D3'
  | 'SPHEREx-D4'
  | 'SPHEREx-D5'
  | 'SPHEREx-D6'
  | string;

export interface SpherexObservation {
  id: string;
  obsId: string;
  publisherDid: string;
  collection: string;
  bandpassName: DetectorBand;
  detectorNumber: number | null;
  emMinUm: number | null;
  emMaxUm: number | null;
  emCenterUm: number | null;
  emResPower: number | null;
  raDeg: number;
  decDeg: number;
  raHms: string;
  decDms: string;
  tMinMjd: number;
  tMaxMjd: number;
  obsDateIso: string;
  obsDateDisplay: string;
  exposureSec: number | null;
  pixelScaleArcsec: number | null;
  fovDeg: number | null;
  widthPx: number | null;
  heightPx: number | null;
  regionPolygon: number[][];
  targetName: string;
  calibLevel: number | null;
  accessUrl: string;
  accessSizeKb: number | null;
  spectralChannel?: number;
  dataSource: 'NASA/IPAC IRSA SIA2' | 'NASA/IPAC SPHEREx DR1 Cube (IRSA/S3)';
}

export interface ObservationsSearchResponse {
  query: {
    raDeg: number;
    decDeg: number;
    raHms: string;
    decDms: string;
    radiusDeg: number;
    collection: string;
    resolvedName?: string;
  };
  sourceStatus: 'live-irsa' | 'live-cube-fallback' | 'irsa-error' | 'empty';
  errorMessage?: string;
  noticeMessage?: string;
  upstreamError?: string;
  totalCount: number;
  observations: SpherexObservation[];
}

export interface FitsHeaderSummary {
  dateObs: string | null;
  mjdObs: number | null;
  mjdAvg: number | null;
  detector: number | null;
  bunit: string | null;
  spsFlags: string | null;
  obsInSband: string | null;
  minGcd2SaaDeg: number | null;
  ctype1: string | null;
  ctype2: string | null;
  crval1: number | null;
  crval2: number | null;
  crpix1: number | null;
  crpix2: number | null;
  pcMatrix: [number, number, number, number] | null;
  hduNames: string[];
}

export interface FitsPhotometrySummary {
  targetPixelX: number | null;
  targetPixelY: number | null;
  apertureRadiusPx: number;
  peakSurfaceBrightness: number | null;
  apertureMeanSurfaceBrightness: number | null;
  zodiMeanBackground: number | null;
  netSurfaceBrightness: number | null;
  uncertaintySigma: number | null;
  unit: string;
  flaggedPixelFraction: number;
  note: string;
}

export interface FitsStats {
  width: number;
  height: number;
  min: number;
  max: number;
  median: number;
  p1: number;
  p99: number;
  validPixels: number;
  totalPixels: number;
  zodiSubtracted: boolean;
  stretch: 'asinh' | 'log' | 'linear';
  colormap: 'infrared' | 'viridis' | 'grayscale' | 'cool';
}

export interface FitsInspectResponse {
  dataSource: 'NASA/IPAC IRSA SPHEREx MEF' | 'NASA/IPAC SPHEREx DR1 Cube';
  cutoutUrl: string;
  pngDataUrl: string;
  headers: FitsHeaderSummary;
  stats: FitsStats;
  photometry: FitsPhotometrySummary;
  rawHeaderCards: string[];
}

export interface FeaturedObservation {
  id: string;
  title: string;
  regionLabel: string;
  scientificContext: string;
  isDemonstrationFallback: boolean;
  fallbackImageUrl?: string;
  observation: SpherexObservation;
  previewImageUrl: string;
  headers?: FitsHeaderSummary;
  photometry?: FitsPhotometrySummary;
}

export interface ChallengeTarget {
  id: string;
  name: string;
  category: string;
  raInput: string;
  decInput: string;
  raDeg: number;
  decDeg: number;
  variabilityType: 'Positional (High Proper Motion / Parallax)' | 'Brightness Variability' | 'Infrared Brown Dwarf';
  summary: string;
  whatToLookFor: string;
}

export interface FitsDiffHotspot {
  id: number;
  dominantIn: 'A' | 'B';
  pixelArea: number;
  peakSigma: number;
  peakDeltaMJySr: number;
  xA: number;
  yA: number;
  xB: number;
  yB: number;
  raDeg: number | null;
  decDeg: number | null;
}

export interface FitsDiffResponse {
  alignmentMode: 'wcs' | 'pixel';
  wcsAvailable: boolean;
  overlapFraction: number;
  thresholdSigma: number;
  matchBackground: boolean;
  medianBackgroundOffset: number;
  noiseSigma: number;
  changedPixelCount: number;
  validOverlapPixelCount: number;
  changedFraction: number;
  brighterInACount: number;
  brighterInBCount: number;
  maxAbsDeltaMJySr: number;
  widthA: number;
  heightA: number;
  widthB: number;
  heightB: number;
  overlayADataUrl: string;
  overlayBDataUrl: string;
  diffMapDataUrl: string;
  hotspots: FitsDiffHotspot[];
}

