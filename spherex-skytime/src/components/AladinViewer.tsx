import { useEffect, useRef, useState } from 'react';
import { Compass, Search, Scan, RefreshCw } from 'lucide-react';
import type { SpherexObservation } from '../types/spherex.ts';

interface AladinOverlay {
  add: (shape: unknown) => void;
  removeAll?: () => void;
}

interface AladinInstance {
  gotoRaDec: (ra: number, dec: number) => void;
  gotoObject?: (
    name: string,
    callbacks?: { success?: (raDec: [number, number]) => void; error?: () => void }
  ) => void;
  setFoV: (fov: number) => void;
  getFoV?: () => [number, number] | number;
  getRaDec?: () => [number, number];
  showCooGrid?: () => void;
  hideCooGrid?: () => void;
  addOverlay: (overlay: AladinOverlay) => void;
  displayFITS?: (
    url: string,
    options?: Record<string, unknown>,
    successCallback?: () => void,
    errorCallback?: () => void,
    layer?: string
  ) => void;
  removeImageLayer?: (layer: string) => void;
  setBaseImageLayer?: (survey: string) => void;
  on?: (eventName: string, handler: (...args: unknown[]) => void) => void;
  view?: {
    redrawClbk?: () => void;
  };
}

interface AladinNamespace {
  init: Promise<void>;
  aladin: (selector: string | HTMLElement, options: Record<string, unknown>) => AladinInstance;
  graphicOverlay: (options?: Record<string, unknown>) => AladinOverlay;
  polygon: (coords: number[][], options?: Record<string, unknown>) => unknown;
  circle?: (ra: number, dec: number, radiusDeg: number, options?: Record<string, unknown>) => unknown;
}

interface AladinViewerProps {
  raDeg: number;
  decDeg: number;
  observation: SpherexObservation | null;
  fallbackPreviewUrl: string | null;
  heightClass?: string;
}

const ALADIN_STABLE_VERSION = '3.8.1';
const JSDELIVR_ESM_URL = `https://cdn.jsdelivr.net/npm/aladin-lite@${ALADIN_STABLE_VERSION}/dist/aladin.js`;
const FITS_OVERLAY_LAYER_ID = 'spherex-fits-overlay';

const SKY_SURVEYS = [
  {
    key: 'spherex',
    name: 'SPHEREx DR1 All-Sky (IR)',
  },
  {
    key: '2mass',
    name: '2MASS Near-IR (Full Sky)',
  },
  {
    key: 'dss',
    name: 'DSS2 Optical (Full Sky)',
  },
  {
    key: 'allwise',
    name: 'AllWISE Mid-IR (Full Sky)',
  },
] as const;

type SurveyKey = (typeof SKY_SURVEYS)[number]['key'];

function getSurveyProxyUrl(key: SurveyKey): string {
  return `${window.location.origin}/api/hips/${key}`;
}

let cachedAladinModulePromise: Promise<AladinNamespace> | null = null;

function notifyFullscreenState(fullscreen: boolean) {
  window.dispatchEvent(
    new CustomEvent('spherex:aladin-fullscreen', { detail: { fullscreen } })
  );
}

async function loadAladinModule(): Promise<AladinNamespace> {
  if (cachedAladinModulePromise) return cachedAladinModulePromise;

  cachedAladinModulePromise = (async () => {
    let aladinNs: AladinNamespace | undefined;

    try {
      const mod = (await import('aladin-lite')) as { default?: AladinNamespace };
      aladinNs = mod.default;
    } catch {
      const mod = (await import(/* @vite-ignore */ JSDELIVR_ESM_URL)) as {
        default?: AladinNamespace;
      };
      aladinNs = mod.default;
    }

    if (
      !aladinNs ||
      typeof aladinNs.aladin !== 'function' ||
      !aladinNs.init ||
      typeof aladinNs.init.then !== 'function'
    ) {
      throw new Error('Aladin Lite v3.8.1 API object did not expose expected methods.');
    }

    await aladinNs.init;
    return aladinNs;
  })().catch((err) => {
    cachedAladinModulePromise = null;
    throw err;
  });

  return cachedAladinModulePromise;
}

export function AladinViewer({
  raDeg,
  decDeg,
  observation,
  fallbackPreviewUrl,
  heightClass = 'h-[430px]',
}: AladinViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const aladinNsRef = useRef<AladinNamespace | null>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const overlayRef = useRef<AladinOverlay | null>(null);
  const initializedRef = useRef(false);

  // Track last applied values so we never re-enter WASM on mount with duplicate calls
  const appliedSurveyRef = useRef<string | null>(null);
  const appliedPosRef = useRef<{ ra: number; dec: number } | null>(null);
  const appliedFovRef = useRef<number | null>(null);
  const appliedGridRef = useRef<boolean>(false);
  const fitsOverlayAddedRef = useRef<boolean>(false);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorDetail, setErrorDetail] = useState<string>('');
  const [retryNonce, setRetryNonce] = useState<number>(0);
  const [fitsStatus, setFitsStatus] = useState<string>('');
  // Default to 8.0° so the complete sky map AND the ~3.5° SPHEREx detector footprint polygon are both visible
  const [fovDeg, setFovDeg] = useState<number>(8.0);
  const [skySurvey, setSkySurvey] = useState<SurveyKey>('spherex');
  const [showGrid, setShowGrid] = useState<boolean>(false);
  const [showFitsOverlay, setShowFitsOverlay] = useState<boolean>(false);
  const [aladinSearch, setAladinSearch] = useState<string>('');
  const [liveCoords, setLiveCoords] = useState<{ ra: number; dec: number }>({
    ra: raDeg,
    dec: decDeg,
  });

  useEffect(() => {
    let cancelled = false;
    let mutationObserver: MutationObserver | null = null;
    const containerEl = containerRef.current;

    const syncFullscreenFromDom = () => {
      if (!containerEl) return;
      const hasFsClass =
        containerEl.classList.contains('aladin-fullscreen') ||
        Boolean(containerEl.querySelector('.aladin-fullscreen')) ||
        Boolean(document.fullscreenElement && containerEl.contains(document.fullscreenElement));
      notifyFullscreenState(hasFsClass);
    };

    const onDocFullscreenChange = () => syncFullscreenFromDom();
    const onAladinFsEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ fullscreen?: boolean }>).detail;
      if (typeof detail?.fullscreen === 'boolean') {
        notifyFullscreenState(detail.fullscreen);
      } else {
        syncFullscreenFromDom();
      }
    };

    document.addEventListener('fullscreenchange', onDocFullscreenChange);
    containerEl?.addEventListener('AL:fullscreen.toggled', onAladinFsEvent);

    setStatus('loading');

    loadAladinModule()
      .then((A) => {
        if (cancelled || !containerRef.current) return;
        aladinNsRef.current = A;

        if (!initializedRef.current) {
          containerRef.current.innerHTML = '';
          const initialSurveyUrl = getSurveyProxyUrl(skySurvey);

          // Omit shortcut tileSize/maxOrder/imgFormat/cooFrame from hipsList so Aladin
          // always fetches /properties from our same-origin proxy (which includes dataproduct_type=image).
          // Disable telemetry logging and MocServer stack startup calls to unreachable external hosts.
          const instance = A.aladin(containerRef.current, {
            survey: initialSurveyUrl,
            hipsList: SKY_SURVEYS.map((s) => ({
              id: getSurveyProxyUrl(s.key),
              name: s.name,
              url: getSurveyProxyUrl(s.key),
            })),
            fov: fovDeg,
            target: `${raDeg} ${decDeg}`,
            cooFrame: 'ICRS',
            log: false,
            showReticle: true,
            showZoomControl: true,
            showFullscreenControl: true,
            showLayersControl: false,
            showCooGridControl: true,
            showSimbadPointerControl: false,
            showCooGrid: false,
          });

          if (!instance || typeof instance.gotoRaDec !== 'function') {
            throw new Error('Aladin Lite instance failed to expose viewer navigation API.');
          }

          aladinRef.current = instance;
          initializedRef.current = true;
          appliedSurveyRef.current = initialSurveyUrl;
          appliedPosRef.current = { ra: raDeg, dec: decDeg };
          appliedFovRef.current = fovDeg;
          appliedGridRef.current = false;
          fitsOverlayAddedRef.current = false;

          if (typeof A.graphicOverlay === 'function') {
            overlayRef.current = A.graphicOverlay({
              color: '#22D3EE',
              lineWidth: 2.5,
            });
            instance.addOverlay(overlayRef.current);
          }

          instance.on?.('positionChanged', () => {
            try {
              const pos = instance.getRaDec?.();
              if (pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
                setLiveCoords({ ra: pos[0], dec: pos[1] });
              }
            } catch {
              // Ignore transient position read errors
            }
          });

          instance.on?.('fullScreenToggled', (isFs) => {
            if (typeof isFs === 'boolean') {
              notifyFullscreenState(isFs);
            } else {
              syncFullscreenFromDom();
            }
          });

          if (containerRef.current) {
            mutationObserver = new MutationObserver(() => syncFullscreenFromDom());
            mutationObserver.observe(containerRef.current, {
              attributes: true,
              attributeFilter: ['class'],
              subtree: true,
            });
          }
        }

        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setErrorDetail(
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'Unable to initialize Aladin Lite v3.8.1 WebGL2 viewer.'
        );
      });

    return () => {
      cancelled = true;
      mutationObserver?.disconnect();
      document.removeEventListener('fullscreenchange', onDocFullscreenChange);
      containerEl?.removeEventListener('AL:fullscreen.toggled', onAladinFsEvent);
      notifyFullscreenState(false);

      // Stop Aladin Lite's internal requestAnimationFrame loop on unmount so detached WASM/WebGL instances never linger
      if (aladinRef.current?.view) {
        aladinRef.current.view.redrawClbk = () => {};
      }
      aladinRef.current = null;
      overlayRef.current = null;
      initializedRef.current = false;
      appliedSurveyRef.current = null;
      appliedPosRef.current = null;
      appliedFovRef.current = null;
      appliedGridRef.current = false;
      fitsOverlayAddedRef.current = false;
    };
  }, [retryNonce]);

  useEffect(() => {
    if (status !== 'ready' || !aladinRef.current) return;
    const prev = appliedPosRef.current;
    if (prev && prev.ra === raDeg && prev.dec === decDeg) return;
    try {
      aladinRef.current.gotoRaDec(raDeg, decDeg);
      appliedPosRef.current = { ra: raDeg, dec: decDeg };
      setLiveCoords({ ra: raDeg, dec: decDeg });
    } catch {
      // Guard against transient WASM errors
    }
  }, [status, raDeg, decDeg]);

  useEffect(() => {
    if (status !== 'ready' || !aladinRef.current) return;
    if (appliedFovRef.current === fovDeg) return;
    try {
      aladinRef.current.setFoV(fovDeg);
      appliedFovRef.current = fovDeg;
    } catch {
      // Guard against transient WASM errors
    }
  }, [status, fovDeg]);

  useEffect(() => {
    if (status !== 'ready' || !aladinRef.current?.setBaseImageLayer) return;
    const surveyUrl = getSurveyProxyUrl(skySurvey);
    if (appliedSurveyRef.current === surveyUrl) return;
    try {
      aladinRef.current.setBaseImageLayer(surveyUrl);
      appliedSurveyRef.current = surveyUrl;
    } catch {
      // Guard against transient WASM errors
    }
  }, [status, skySurvey]);

  useEffect(() => {
    if (status !== 'ready' || !aladinRef.current) return;
    if (appliedGridRef.current === showGrid) return;
    try {
      if (showGrid) {
        aladinRef.current.showCooGrid?.();
      } else {
        aladinRef.current.hideCooGrid?.();
      }
      appliedGridRef.current = showGrid;
    } catch {
      // Guard against transient WASM errors
    }
  }, [status, showGrid]);

  // Highlight the matching SPHEREx footprint & target circle on the complete space map;
  // only overlay the cropped FITS cutout when the user explicitly toggles Overlay FITS ON.
  useEffect(() => {
    const A = aladinNsRef.current;
    if (status !== 'ready' || !aladinRef.current || !A) return;

    try {
      if (overlayRef.current) {
        overlayRef.current.removeAll?.();

        // Highlight the matching SPHEREx exposure footprint polygon on the full space map (shallow copy avoids Aladin mutating state)
        if (
          observation?.regionPolygon &&
          observation.regionPolygon.length >= 3 &&
          typeof A.polygon === 'function'
        ) {
          const polygonCopy = observation.regionPolygon.map((pt) => [pt[0], pt[1]]);
          overlayRef.current.add(
            A.polygon(polygonCopy, {
              color: '#22D3EE',
              lineWidth: 2.5,
              fill: true,
              fillColor: 'rgba(34, 211, 238, 0.16)',
            })
          );
        }

        // Highlight the matched target search region
        if (typeof A.circle === 'function') {
          overlayRef.current.add(
            A.circle(raDeg, decDeg, 0.12, {
              color: '#FBBF24',
              lineWidth: 2.5,
            })
          );
        }
      }
    } catch {
      // Ignore graphic overlay error
    }

    if (!showFitsOverlay) {
      if (fitsOverlayAddedRef.current) {
        try {
          aladinRef.current.removeImageLayer?.(FITS_OVERLAY_LAYER_ID);
        } catch {
          // Ignore if layer was not attached yet
        }
        fitsOverlayAddedRef.current = false;
      }
      if (observation) {
        setFitsStatus(
          `Complete sky map · Highlighting SPHEREx ${observation.obsId} (${observation.bandpassName}) matching region`
        );
      } else {
        setFitsStatus(`Aladin Lite v${ALADIN_STABLE_VERSION} · Complete Sky Map`);
      }
      return;
    }

    if (observation?.accessUrl) {
      const fitsUrl = `/api/fits-single-hdu?access_url=${encodeURIComponent(
        observation.accessUrl
      )}&ra=${raDeg}&dec=${decDeg}&size=0.08`;

      setFitsStatus(`Aligning ${observation.obsId} (${observation.bandpassName}) FITS overlay...`);
      try {
        if (typeof aladinRef.current.displayFITS === 'function') {
          fitsOverlayAddedRef.current = true;
          aladinRef.current.displayFITS(
            fitsUrl,
            {
              name: `SPHEREx ${observation.bandpassName}`,
              colorMap: 'inferno',
              opacity: 0.65,
            },
            () =>
              setFitsStatus(
                `Complete sky map + SPHEREx ${observation.obsId} cutout overlay (${observation.obsDateDisplay.slice(0, 10)})`
              ),
            () =>
              setFitsStatus(
                `Complete sky map · Highlighting SPHEREx ${observation.obsId} matching region`
              ),
            FITS_OVERLAY_LAYER_ID
          );
        }
      } catch {
        setFitsStatus(
          `Complete sky map · Highlighting SPHEREx ${observation.obsId} matching region`
        );
      }
    }
  }, [status, raDeg, decDeg, observation, showFitsOverlay]);

  const handleAladinObjectSearch = async () => {
    const q = aladinSearch.trim();
    if (!q || !aladinRef.current) return;

    try {
      const resp = await fetch(`/api/resolve-target?name=${encodeURIComponent(q)}`);
      if (resp.ok) {
        const data = (await resp.json()) as {
          found?: boolean;
          raDeg?: number;
          decDeg?: number;
          canonicalName?: string;
        };
        if (
          data.found &&
          typeof data.raDeg === 'number' &&
          typeof data.decDeg === 'number'
        ) {
          aladinRef.current.gotoRaDec(data.raDeg, data.decDeg);
          appliedPosRef.current = { ra: data.raDeg, dec: data.decDeg };
          setLiveCoords({ ra: data.raDeg, dec: data.decDeg });
          setFitsStatus(`Centered Aladin Lite on ${data.canonicalName || q}`);
          return;
        }
      }
    } catch {
      // Fall through to Aladin resolver below if local resolve fails
    }

    aladinRef.current.gotoObject?.(q, {
      success: (coords) => {
        setLiveCoords({ ra: coords[0], dec: coords[1] });
        setFitsStatus(`Centered Aladin Lite on ${q}`);
      },
      error: () => {
        setFitsStatus(`Object "${q}" not found in resolver`);
      },
    });
  };

  if (status === 'error') {
    return (
      <div className="flex flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#050811]">
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-[#070C18] px-3 py-2 text-xs text-amber-300">
          <span>Interactive sky viewer temporarily unavailable — displaying retrieved SPHEREx cutout</span>
          <button
            type="button"
            onClick={() => setRetryNonce((n) => n + 1)}
            className="inline-flex items-center gap-1 rounded border border-cyan-500/50 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/20 cursor-pointer whitespace-nowrap shrink-0"
          >
            <RefreshCw className="h-3 w-3" />
            <span>Retry</span>
          </button>
        </div>
        <div className={`flex ${heightClass} flex-col items-center justify-center p-5 text-center`}>
          {fallbackPreviewUrl ? (
            <img
              src={fallbackPreviewUrl}
              alt={
                observation
                  ? `SPHEREx ${observation.bandpassName} cutout on ${observation.obsDateDisplay}`
                  : 'SPHEREx FITS cutout'
              }
              referrerPolicy="no-referrer"
              className="max-h-[250px] w-auto rounded-lg border border-slate-800 object-contain [image-rendering:pixelated]"
            />
          ) : (
            <p className="text-xs text-slate-400">
              Select a SPHEREx observation below to view its processed FITS cutout.
            </p>
          )}
          <p className="mt-3 max-w-md text-[11px] text-slate-400">
            Aladin Lite note: {errorDetail}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#050811]">
      {/* Aladin Toolbar ABOVE canvas so the Aladin Lite bottom-right attribution logo is never obscured */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-[#070C18] px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={aladinSearch}
              onChange={(e) => setAladinSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAladinObjectSearch();
              }}
              placeholder="Pan Aladin to object..."
              aria-label="Search astronomical object in Aladin Lite"
              className="w-32 rounded border border-slate-700 bg-[#050811] px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none sm:w-36"
            />
            <button
              type="button"
              onClick={() => void handleAladinObjectSearch()}
              aria-label="Go to object"
              className="inline-flex items-center justify-center rounded border border-slate-700 bg-slate-900 p-1 text-slate-200 hover:text-white cursor-pointer"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          </div>

          <select
            aria-label="All-Sky Survey"
            value={skySurvey}
            onChange={(e) => setSkySurvey(e.target.value as SurveyKey)}
            className="rounded border border-slate-700 bg-[#050811] px-2 py-1 text-[11px] text-slate-200"
          >
            {SKY_SURVEYS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>

          <select
            aria-label="Field of View"
            value={fovDeg}
            onChange={(e) => setFovDeg(Number(e.target.value))}
            className="rounded border border-slate-700 bg-[#050811] px-2 py-1 font-mono text-[11px] text-slate-200"
          >
            <option value={0.6}>FoV 0.60°</option>
            <option value={2.0}>FoV 2.00°</option>
            <option value={8.0}>FoV 8.00° (Footprint)</option>
            <option value={20.0}>FoV 20.0°</option>
            <option value={60.0}>FoV 60.0° (All-Sky)</option>
          </select>

          <button
            type="button"
            onClick={() => setShowGrid((g) => !g)}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] cursor-pointer whitespace-nowrap shrink-0 ${
              showGrid
                ? 'border-cyan-400/70 bg-cyan-500/15 text-cyan-200'
                : 'border-slate-700 bg-[#050811] text-slate-300'
            }`}
          >
            <Compass className="h-3 w-3" />
            <span>Grid</span>
          </button>

          <button
            type="button"
            onClick={() => setShowFitsOverlay((f) => !f)}
            title="Optional: overlay the cropped SPHEREx FITS pixels onto the sky map"
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] cursor-pointer whitespace-nowrap shrink-0 ${
              showFitsOverlay
                ? 'border-amber-400/70 bg-amber-500/15 text-amber-200'
                : 'border-slate-700 bg-[#050811] text-slate-300'
            }`}
          >
            <Scan className="h-3 w-3" />
            <span>Overlay FITS</span>
          </button>
        </div>

        <div className="font-mono tabular-nums text-[11px] text-slate-400">
          ICRS {liveCoords.ra.toFixed(4)}°, {liveCoords.dec.toFixed(4)}°
        </div>
      </div>

      {/* Pure Aladin Lite Viewport — bottom-right logo & link remain 100% visible & clickable */}
      <div className={`relative w-full ${heightClass}`}>
        <div ref={containerRef} className="h-full w-full" />
        {status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#050811]/95">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
            <p className="text-xs text-slate-300">
              Initializing Aladin Lite v{ALADIN_STABLE_VERSION} sky viewer...
            </p>
          </div>
        )}
      </div>

      {/* Status Footer OUTSIDE canvas so nothing ever overlaps Aladin Lite's bottom-right corner */}
      <div className="border-t border-slate-800 bg-[#070C18] px-3 py-1.5 font-mono text-[11px] text-slate-400">
        {fitsStatus || `Aladin Lite v${ALADIN_STABLE_VERSION} · Complete Sky Map + SPHEREx Highlight`}
      </div>
    </div>
  );
}
