import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  ZoomIn,
  ZoomOut,
  ExternalLink,
  AlertCircle,
  Layers,
  Columns,
  Globe,
  Eye,
  LayoutGrid,
  Loader2,
  XCircle,
  Info,
  ScanSearch,
  RefreshCw,
} from 'lucide-react';
import type {
  ChallengeTarget,
  FitsDiffResponse,
  FitsInspectResponse,
  ObservationsSearchResponse,
  SpherexObservation,
} from '../types/spherex.ts';
import { AladinViewer } from './AladinViewer.tsx';
import { ScientificCharts } from './ScientificCharts.tsx';
import {
  deduplicateChronological,
  runObservationPrepQueue,
  type ObservationPrepRecord,
} from '../utils/observationQueue.ts';

type ViewMode = 'split' | 'single' | 'aladin' | 'side-by-side' | 'compare-timelapse' | 'overlay';

interface SkyExplorerProps {
  targets: ChallengeTarget[];
  targetsLoading?: boolean;
  targetsError?: string | null;
  onRetryTargets?: () => void;
  externalLoadRequest: {
    raInput: string;
    decInput: string;
    label?: string;
    preferObsId?: string;
    nonce: number;
  } | null;
}

class ApiClientError extends Error {
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, code?: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function safeFetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, { signal });
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const text = await resp.text();
  const trimmed = text.trimStart();

  if (contentType.includes('text/html') || trimmed.startsWith('<')) {
    throw new ApiClientError(
      `Archive service returned an HTML response instead of observation data (HTTP ${resp.status}).`,
      'HTML_RESPONSE',
      true
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiClientError(
      `Unexpected response format from archive proxy (HTTP ${resp.status}).`,
      'INVALID_JSON',
      false
    );
  }

  if (!resp.ok) {
    const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const errMsg = obj.error ? String(obj.error) : `Request failed with HTTP ${resp.status}`;
    const errCode = obj.errorCode ? String(obj.errorCode) : undefined;
    const retryable = resp.status >= 500 && resp.status !== 504 && errCode !== 'INVALID_FITS';
    throw new ApiClientError(errMsg, errCode, retryable);
  }

  return parsed as T;
}

export function SkyExplorer({
  targets,
  targetsLoading = false,
  targetsError = null,
  onRetryTargets,
  externalLoadRequest,
}: SkyExplorerProps) {
  // Search controls
  const [objectQuery, setObjectQuery] = useState('');
  const [raInput, setRaInput] = useState('08h55m10.831s');
  const [decInput, setDecInput] = useState('-07d14m42.53s');
  const [radiusDeg, setRadiusDeg] = useState('0.08');
  const [activeTargetLabel, setActiveTargetLabel] = useState<string>('WISE 0855');
  const [showCoordHelp, setShowCoordHelp] = useState(false);

  // Archive search state
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<ObservationsSearchResponse | null>(null);

  // Filters & timeline selection
  const [bandFilter, setBandFilter] = useState<string>('SPHEREx-D4');
  const [selectedObsId, setSelectedObsId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackMs, setPlaybackMs] = useState<number>(950);

  // Preparation queue state
  const [isPreparingQueue, setIsPreparingQueue] = useState(false);
  const [prepCompleted, setPrepCompleted] = useState(false);
  const [prepMap, setPrepMap] = useState<Record<string, ObservationPrepRecord>>({});
  const [showFailedDetails, setShowFailedDetails] = useState(false);

  // View & FITS rendering controls
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [stretch, setStretch] = useState<'asinh' | 'log' | 'linear'>('asinh');
  const [colormap, setColormap] = useState<'infrared' | 'cool' | 'viridis' | 'grayscale'>(
    'infrared'
  );
  const [subtractZodi, setSubtractZodi] = useState<boolean>(true);
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [showAdvancedMeta, setShowAdvancedMeta] = useState(false);

  // Processed FITS inspection cache keyed by `${obs.id}|${stretch}|${colormap}|${subtractZodi}`
  const [fitsCache, setFitsCache] = useState<Record<string, FitsInspectResponse>>({});
  const fitsCacheRef = useRef<Record<string, FitsInspectResponse>>({});
  const [lastDisplayedInspect, setLastDisplayedInspect] = useState<FitsInspectResponse | null>(null);
  const [photometryMap, setPhotometryMap] = useState<Record<string, FitsInspectResponse>>({});
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);
  const [frameErrorMap, setFrameErrorMap] = useState<Record<string, string>>({});
  const [isSampling, setIsSampling] = useState(false);

  // Comparison state (Side-by-Side & Overlay)
  const [compareIdA, setCompareIdA] = useState<string>('');
  const [compareIdB, setCompareIdB] = useState<string>('');
  const [overlayOpacity, setOverlayOpacity] = useState<number>(50);
  const [isBlinking, setIsBlinking] = useState<boolean>(false);
  const [blinkShowB, setBlinkShowB] = useState<boolean>(false);

  // Compare Two (stable) difference highlighting state
  const [highlightDiff, setHighlightDiff] = useState<boolean>(true);
  const [diffThresholdSigma, setDiffThresholdSigma] = useState<number>(3.0);
  const [diffMatchBackground, setDiffMatchBackground] = useState<boolean>(true);
  const [diffAlignMode, setDiffAlignMode] = useState<'wcs' | 'pixel'>('wcs');
  const [diffOverlayOpacity, setDiffOverlayOpacity] = useState<number>(85);
  const [diffResult, setDiffResult] = useState<FitsDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffRetryNonce, setDiffRetryNonce] = useState<number>(0);
  const [selectedHotspotId, setSelectedHotspotId] = useState<number | null>(null);
  const lastDiffPairRef = useRef<string>('');

  // Concurrency / race-condition guards & playback timer refs
  const initialLoadedRef = useRef(false);
  const lastSearchActionRef = useRef<
    | { type: 'coords'; ra: string; dec: string; label?: string; preferObsId?: string }
    | { type: 'resolve'; query: string }
  >({
    type: 'coords',
    ra: '08h55m10.831s',
    dec: '-07d14m42.53s',
    label: 'WISE 0855',
  });
  const searchTokenRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const prepAbortRef = useRef<AbortController | null>(null);
  const playbackTimerRef = useRef<number | null>(null);
  const [frameImageSettledNonce, setFrameImageSettledNonce] = useState(0);

  const availableBands = useMemo(() => {
    const set = new Set<string>();
    (searchResult?.observations || []).forEach((o) => set.add(o.bandpassName));
    return Array.from(set).sort();
  }, [searchResult]);

  const filteredObservations = useMemo(() => {
    const all = deduplicateChronological(searchResult?.observations || []);
    if (bandFilter === 'ALL') return all;
    const filtered = all.filter((o) => o.bandpassName === bandFilter);
    return filtered.length > 0 ? filtered : all;
  }, [searchResult, bandFilter]);

  const renderKey = useCallback(
    (obsId: string) => `${obsId}|${stretch}|${colormap}|${subtractZodi}`,
    [stretch, colormap, subtractZodi]
  );

  // Only ready observations participate in chronological time-lapse playback
  const readyObservations = useMemo(() => {
    return filteredObservations.filter((obs) => {
      const hasCached = Boolean(fitsCache[renderKey(obs.id)]?.pngDataUrl);
      const rec = prepMap[obs.id];
      return hasCached && (!rec || rec.status === 'ready');
    });
  }, [filteredObservations, fitsCache, prepMap, renderKey]);

  const unavailableRecords = useMemo(() => {
    return filteredObservations
      .map((obs) => prepMap[obs.id])
      .filter(
        (rec): rec is ObservationPrepRecord =>
          Boolean(rec && (rec.status === 'failed' || rec.status === 'timed-out'))
      );
  }, [filteredObservations, prepMap]);

  const prepSummary = useMemo(() => {
    const total = filteredObservations.length;
    let ready = 0;
    let failedOrTimeout = 0;
    let inProgress = 0;
    let pending = 0;

    for (const obs of filteredObservations) {
      const rec = prepMap[obs.id];
      const cached = Boolean(fitsCache[renderKey(obs.id)]?.pngDataUrl);
      if (rec) {
        if (rec.status === 'ready' && cached) ready++;
        else if (rec.status === 'failed' || rec.status === 'timed-out') failedOrTimeout++;
        else if (rec.status === 'loading' || rec.status === 'processing') inProgress++;
        else pending++;
      } else if (cached) {
        ready++;
      } else {
        pending++;
      }
    }

    return {
      total,
      ready,
      failedOrTimeout,
      remaining: inProgress + pending,
    };
  }, [filteredObservations, prepMap, fitsCache, renderKey]);

  const activeObs: SpherexObservation | null = useMemo(() => {
    if (filteredObservations.length === 0) return null;
    if (selectedObsId) {
      const found = filteredObservations.find((o) => o.id === selectedObsId);
      if (found) return found;
    }
    return filteredObservations[0];
  }, [filteredObservations, selectedObsId]);

  const activeReadyIndex = useMemo(() => {
    if (!activeObs) return -1;
    return readyObservations.findIndex((o) => o.id === activeObs.id);
  }, [readyObservations, activeObs]);

  const clearPlaybackTimer = useCallback(() => {
    if (playbackTimerRef.current !== null) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  }, []);

  const cancelPrepQueue = useCallback(() => {
    prepAbortRef.current?.abort();
    prepAbortRef.current = null;
    setIsPreparingQueue(false);
  }, []);

  // Cleanup timers and in-flight tasks on unmount
  useEffect(() => {
    return () => {
      clearPlaybackTimer();
      prepAbortRef.current?.abort();
      searchAbortRef.current?.abort();
    };
  }, [clearPlaybackTimer]);

  const inspectObservation = useCallback(
    async (
      obs: SpherexObservation,
      raDeg: number,
      decDeg: number,
      opts?: {
        silent?: boolean;
        signal?: AbortSignal;
        token?: number;
        onStage?: (stage: 'loading' | 'processing') => void;
      }
    ): Promise<
      | { ok: true; data: FitsInspectResponse }
      | { ok: false; status: 'failed' | 'timed-out'; error: string; errorCode?: string; retryable?: boolean }
    > => {
      const key = `${obs.id}|${stretch}|${colormap}|${subtractZodi}`;
      const existing = fitsCacheRef.current[key];
      if (existing) {
        return { ok: true, data: existing };
      }

      if (!opts?.silent) {
        setSingleLoading(true);
        setSingleError(null);
      }

      try {
        opts?.onStage?.('loading');
        const qs = new URLSearchParams({
          access_url: obs.accessUrl,
          ra: String(raDeg),
          dec: String(decDeg),
          size: '0.08',
          stretch,
          colormap,
          subtractZodi: String(subtractZodi),
        });
        const inspected = await safeFetchJson<FitsInspectResponse>(
          `/api/fits-inspect?${qs.toString()}`,
          opts?.signal
        );

        if (opts?.token !== undefined && opts.token !== searchTokenRef.current) {
          return { ok: false, status: 'failed', error: 'Superseded by a newer search.' };
        }

        opts?.onStage?.('processing');

        if (!inspected || !inspected.pngDataUrl || !inspected.pngDataUrl.startsWith('data:image/png')) {
          return {
            ok: false,
            status: 'failed',
            error: 'Processed response did not contain a valid image.',
            errorCode: 'INVALID_FITS',
            retryable: false,
          };
        }

        fitsCacheRef.current = { ...fitsCacheRef.current, [key]: inspected };
        setFitsCache((prev) => ({ ...prev, [key]: inspected }));
        setPhotometryMap((prev) => ({ ...prev, [obs.id]: inspected }));
        setFrameErrorMap((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return { ok: true, data: inspected };
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          const isTimeout = opts?.signal?.reason === 'timeout';
          const abortMsg = isTimeout
            ? 'Observation preparation exceeded the 30-second timeout.'
            : 'Request cancelled.';
          if (isTimeout) {
            setFrameErrorMap((prev) => ({ ...prev, [key]: abortMsg }));
          }
          return {
            ok: false,
            status: isTimeout ? 'timed-out' : 'failed',
            error: abortMsg,
            errorCode: isTimeout ? 'TIMEOUT' : 'ABORTED',
            retryable: false,
          };
        }

        const apiErr = err instanceof ApiClientError ? err : null;
        const isTimeout = apiErr?.code === 'TIMEOUT';
        const message = err instanceof Error ? err.message : 'Unable to process FITS image.';

        setFrameErrorMap((prev) => ({ ...prev, [key]: message }));

        if (!opts?.silent && (opts?.token === undefined || opts.token === searchTokenRef.current)) {
          setSingleError(message);
        }

        return {
          ok: false,
          status: isTimeout ? 'timed-out' : 'failed',
          error: message,
          errorCode: apiErr?.code,
          retryable: apiErr?.retryable ?? false,
        };
      } finally {
        if (!opts?.silent && (opts?.token === undefined || opts.token === searchTokenRef.current)) {
          setSingleLoading(false);
        }
      }
    },
    [stretch, colormap, subtractZodi]
  );

  const executeCoordinateSearch = useCallback(
    async (ra: string, dec: string, label?: string, preferObsId?: string) => {
      lastSearchActionRef.current = { type: 'coords', ra, dec, label, preferObsId };
      const token = ++searchTokenRef.current;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;

      cancelPrepQueue();
      clearPlaybackTimer();
      setIsPlaying(false);
      setPrepCompleted(false);
      setPrepMap({});
      setShowFailedDetails(false);
      setFrameErrorMap({});
      setSearchLoading(true);
      setSearchError(null);
      setSingleError(null);
      setSelectedObsId(null);
      setPhotometryMap({});

      try {
        const qs = new URLSearchParams({
          ra: ra.trim(),
          dec: dec.trim(),
          radius: radiusDeg,
          collection: 'spherex_dr1',
        });
        if (label) qs.set('name', label);

        const result = await safeFetchJson<ObservationsSearchResponse>(
          `/api/observations?${qs.toString()}`,
          controller.signal
        );

        if (token !== searchTokenRef.current) return;

        const uniqueObs = deduplicateChronological(result.observations || []);
        const cleanResult: ObservationsSearchResponse = {
          ...result,
          observations: uniqueObs,
          totalCount: uniqueObs.length,
        };
        setSearchResult(cleanResult);

        if (cleanResult.sourceStatus === 'irsa-error') {
          setSearchError(cleanResult.errorMessage || 'Failed to query IRSA archive.');
          return;
        }

        if (uniqueObs.length > 0) {
          const targetPref = preferObsId
            ? uniqueObs.find((o) => o.obsId === preferObsId)
            : undefined;
          const defaultBand = targetPref
            ? targetPref.bandpassName
            : uniqueObs.some((o) => o.bandpassName === 'SPHEREx-D4')
              ? 'SPHEREx-D4'
              : 'ALL';
          setBandFilter(defaultBand);

          const bandList =
            defaultBand === 'ALL'
              ? uniqueObs
              : uniqueObs.filter((o) => o.bandpassName === defaultBand);

          const firstObs =
            (preferObsId && bandList.find((o) => o.obsId === preferObsId)) || bandList[0];
          if (firstObs) setSelectedObsId(firstObs.id);

          setCompareIdA(bandList[0]?.id || uniqueObs[0].id);
          setCompareIdB(
            bandList[Math.min(bandList.length - 1, 1)]?.id ||
              uniqueObs[Math.min(uniqueObs.length - 1, 1)].id
          );
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (token !== searchTokenRef.current) return;
        setSearchError(
          err instanceof Error ? err.message : 'Network error querying SPHEREx observations.'
        );
      } finally {
        if (token === searchTokenRef.current) {
          setSearchLoading(false);
        }
      }
    },
    [radiusDeg, cancelPrepQueue, clearPlaybackTimer]
  );

  // Initial load of WISE 0855 example
  useEffect(() => {
    if (!initialLoadedRef.current) {
      initialLoadedRef.current = true;
      executeCoordinateSearch('08h55m10.831s', '-07d14m42.53s', 'WISE 0855');
    }
  }, [executeCoordinateSearch]);

  // External load requests (from Featured Picture of the Day or Gallery)
  useEffect(() => {
    if (!externalLoadRequest) return;
    setRaInput(externalLoadRequest.raInput);
    setDecInput(externalLoadRequest.decInput);
    setActiveTargetLabel(externalLoadRequest.label || 'Selected Region');
    executeCoordinateSearch(
      externalLoadRequest.raInput,
      externalLoadRequest.decInput,
      externalLoadRequest.label,
      externalLoadRequest.preferObsId
    );
  }, [externalLoadRequest, executeCoordinateSearch]);

  // Fetch single selected observation when not playing (keep previous image visible while loading!)
  useEffect(() => {
    if (!activeObs || !searchResult) return;
    const key = renderKey(activeObs.id);
    const cached = fitsCacheRef.current[key];
    if (cached) {
      setLastDisplayedInspect(cached);
      setSingleError(null);
      return;
    }
    if (isPlaying) return;

    const token = searchTokenRef.current;
    const controller = new AbortController();

    inspectObservation(activeObs, searchResult.query.raDeg, searchResult.query.decDeg, {
      signal: controller.signal,
      token,
    }).then((res) => {
      if (token !== searchTokenRef.current || controller.signal.aborted) return;
      if (res.ok) {
        setLastDisplayedInspect(res.data);
        setPrepMap((prev) => ({
          ...prev,
          [activeObs.id]: {
            id: activeObs.id,
            obsId: activeObs.obsId,
            dateDisplay: activeObs.obsDateDisplay,
            bandpass: activeObs.bandpassName,
            status: 'ready',
            attempts: 1,
          },
        }));
      } else {
        setPrepMap((prev) => ({
          ...prev,
          [activeObs.id]: {
            id: activeObs.id,
            obsId: activeObs.obsId,
            dateDisplay: activeObs.obsDateDisplay,
            bandpass: activeObs.bandpassName,
            status: res.status,
            error: res.error,
            errorCode: res.errorCode,
            attempts: 1,
          },
        }));
      }
    });

    return () => {
      controller.abort();
    };
  }, [activeObs, searchResult, stretch, colormap, subtractZodi, isPlaying, inspectObservation, renderKey]);

  // Playback scheduler: ONLY advances across readyObservations, scheduling the next frame AFTER current frame settles
  useEffect(() => {
    clearPlaybackTimer();

    if (!isPlaying || readyObservations.length < 2) {
      if (isPlaying && readyObservations.length < 2) {
        setIsPlaying(false);
      }
      return;
    }

    const currentIdx = readyObservations.findIndex((o) => o.id === activeObs?.id);
    const safeIdx = currentIdx >= 0 ? currentIdx : 0;

    playbackTimerRef.current = window.setTimeout(() => {
      const nextIdx = (safeIdx + 1) % readyObservations.length;
      const nextObs = readyObservations[nextIdx];
      if (nextObs) {
        setSelectedObsId(nextObs.id);
      }
    }, playbackMs);

    return () => {
      clearPlaybackTimer();
    };
  }, [isPlaying, readyObservations, activeObs, playbackMs, frameImageSettledNonce, clearPlaybackTimer]);

  // Blink compare timer
  useEffect(() => {
    if (!isBlinking || viewMode !== 'overlay') return;
    const timer = window.setInterval(() => {
      setBlinkShowB((prev) => !prev);
    }, 650);
    return () => window.clearInterval(timer);
  }, [isBlinking, viewMode]);

  // Load comparison frames for Side-by-Side, Reference vs Time-Lapse, and Overlay modes
  useEffect(() => {
    if (
      (viewMode !== 'side-by-side' &&
        viewMode !== 'overlay' &&
        viewMode !== 'compare-timelapse') ||
      !searchResult
    ) {
      return;
    }
    const obsA = filteredObservations.find((o) => o.id === compareIdA) || filteredObservations[0];
    const obsB =
      filteredObservations.find((o) => o.id === compareIdB) ||
      filteredObservations[Math.min(1, filteredObservations.length - 1)];

    if (obsA) {
      inspectObservation(obsA, searchResult.query.raDeg, searchResult.query.decDeg, {
        silent: true,
      });
    }
    if (viewMode !== 'compare-timelapse' && obsB && obsB.id !== obsA?.id) {
      inspectObservation(obsB, searchResult.query.raDeg, searchResult.query.decDeg, {
        silent: true,
      });
    }
  }, [viewMode, compareIdA, compareIdB, filteredObservations, searchResult, inspectObservation]);

  // Compute pixel/WCS difference highlight ONLY in Compare Two (side-by-side) mode
  useEffect(() => {
    setSelectedHotspotId(null);

    if (viewMode !== 'side-by-side' || !highlightDiff || !searchResult) {
      return;
    }

    const obsA = filteredObservations.find((o) => o.id === compareIdA) || filteredObservations[0];
    const obsB =
      filteredObservations.find((o) => o.id === compareIdB) ||
      filteredObservations[Math.min(1, filteredObservations.length - 1)];

    if (!obsA || !obsB || obsA.id === obsB.id) {
      lastDiffPairRef.current = '';
      setDiffResult(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }

    const pairKey = `${obsA.id}|${obsB.id}|${subtractZodi}`;
    if (lastDiffPairRef.current !== pairKey) {
      lastDiffPairRef.current = pairKey;
      setDiffResult(null);
    }

    const controller = new AbortController();
    setDiffLoading(true);
    setDiffError(null);

    const timer = window.setTimeout(() => {
      const qs = new URLSearchParams({
        access_url_a: obsA.accessUrl,
        access_url_b: obsB.accessUrl,
        ra: String(searchResult.query.raDeg),
        dec: String(searchResult.query.decDeg),
        size: '0.08',
        subtractZodi: String(subtractZodi),
        thresholdSigma: String(diffThresholdSigma),
        matchBackground: String(diffMatchBackground),
        alignMode: diffAlignMode,
      });

      safeFetchJson<FitsDiffResponse>(`/api/fits-diff?${qs.toString()}`, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) {
            setDiffResult(data);
            setDiffLoading(false);
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (!controller.signal.aborted) {
            setDiffError(err instanceof Error ? err.message : 'Unable to compute difference map.');
            setDiffLoading(false);
          }
        });
    }, 120);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    viewMode,
    highlightDiff,
    searchResult,
    filteredObservations,
    compareIdA,
    compareIdB,
    subtractZodi,
    diffThresholdSigma,
    diffMatchBackground,
    diffAlignMode,
    diffRetryNonce,
  ]);

  const startPreparationAndPlay = async (autoPlayAfter = true) => {
    if (!searchResult || filteredObservations.length === 0) return;

    if (isPreparingQueue) {
      cancelPrepQueue();
      return;
    }

    const token = searchTokenRef.current;
    const controller = new AbortController();
    prepAbortRef.current = controller;

    clearPlaybackTimer();
    setIsPlaying(false);
    setIsPreparingQueue(true);
    setPrepCompleted(false);
    setSingleError(null);

    const result = await runObservationPrepQueue({
      observations: filteredObservations,
      concurrency: 2,
      isAlreadyCached: (obs) => Boolean(fitsCacheRef.current[renderKey(obs.id)]?.pngDataUrl),
      prepareOne: async (obs, onStage, obsSignal) => {
        const res = await inspectObservation(
          obs,
          searchResult.query.raDeg,
          searchResult.query.decDeg,
          {
            silent: true,
            signal: obsSignal,
            token,
            onStage,
          }
        );
        if (res.ok) return { ok: true };
        return {
          ok: false,
          status: res.status,
          error: res.error,
          errorCode: res.errorCode,
          retryable: res.retryable,
        };
      },
      onRecordUpdate: (record) => {
        if (token !== searchTokenRef.current || controller.signal.aborted) return;
        setPrepMap((prev) => ({ ...prev, [record.id]: record }));
      },
      signal: controller.signal,
    });

    if (token !== searchTokenRef.current || result.aborted) {
      setIsPreparingQueue(false);
      return;
    }

    setIsPreparingQueue(false);
    setPrepCompleted(true);
    prepAbortRef.current = null;

    if (result.readyIds.length >= 2 && autoPlayAfter) {
      const firstReadyObs = filteredObservations.find((o) => result.readyIds.includes(o.id));
      if (firstReadyObs) {
        setSelectedObsId(firstReadyObs.id);
      }
      setIsPlaying(true);
    } else if (result.readyIds.length === 1) {
      setSelectedObsId(result.readyIds[0]);
    }
  };

  const handleToggleTimelapse = async () => {
    if (isPlaying) {
      clearPlaybackTimer();
      setIsPlaying(false);
      return;
    }

    if (isPreparingQueue) {
      cancelPrepQueue();
      return;
    }

    // If all observations have not yet been through preparation, prepare the queue first
    if (!prepCompleted && prepSummary.remaining > 0) {
      await startPreparationAndPlay(true);
      return;
    }

    if (readyObservations.length < 2) {
      return;
    }

    // Ensure active frame is a ready observation before starting playback
    if (!activeObs || !readyObservations.some((o) => o.id === activeObs.id)) {
      setSelectedObsId(readyObservations[0].id);
    }
    setIsPlaying(true);
  };

  const handleStep = (direction: -1 | 1) => {
    clearPlaybackTimer();
    setIsPlaying(false);

    // If preparation completed with skips, step cleanly through readyObservations; otherwise step filteredObservations
    const list = prepCompleted && readyObservations.length > 0 ? readyObservations : filteredObservations;
    if (list.length <= 1) return;

    const currentIdx = list.findIndex((o) => o.id === activeObs?.id);
    const baseIdx = currentIdx >= 0 ? currentIdx : 0;
    const nextIdx = (baseIdx + direction + list.length) % list.length;
    setSelectedObsId(list[nextIdx].id);
  };

  const handleResolveObjectName = async (queryOverride?: string) => {
    const query = (queryOverride ?? objectQuery).trim();
    if (!query) return;
    lastSearchActionRef.current = { type: 'resolve', query };
    setSearchLoading(true);
    setSearchError(null);
    try {
      const data = await safeFetchJson<{
        found: boolean;
        name: string;
        raHms: string;
        decDms: string;
        error?: string;
      }>(`/api/resolve-target?name=${encodeURIComponent(query)}`);
      if (!data.found) {
        setSearchError(data.error || `Could not resolve "${query}".`);
        setSearchLoading(false);
        return;
      }
      setRaInput(data.raHms);
      setDecInput(data.decDms);
      setActiveTargetLabel(data.name);
      await executeCoordinateSearch(data.raHms, data.decDms, data.name);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Object resolution error.');
      setSearchLoading(false);
    }
  };

  const handleRetrySearch = () => {
    if (targets.length === 0 && onRetryTargets) {
      onRetryTargets();
    }
    const last = lastSearchActionRef.current;
    if (last.type === 'resolve') {
      void handleResolveObjectName(last.query);
    } else {
      void executeCoordinateSearch(last.ra, last.dec, last.label, last.preferObsId);
    }
  };

  const retrySingleObservation = () => {
    if (!activeObs || !searchResult) return;
    const key = renderKey(activeObs.id);
    setFrameErrorMap((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setSingleError(null);
    const token = searchTokenRef.current;
    void inspectObservation(activeObs, searchResult.query.raDeg, searchResult.query.decDeg, {
      silent: false,
      token,
    }).then((res) => {
      if (token !== searchTokenRef.current) return;
      if (res.ok) {
        setLastDisplayedInspect(res.data);
        setPrepMap((prev) => ({
          ...prev,
          [activeObs.id]: {
            id: activeObs.id,
            obsId: activeObs.obsId,
            dateDisplay: activeObs.obsDateDisplay,
            bandpass: activeObs.bandpassName,
            status: 'ready',
            attempts: (prev[activeObs.id]?.attempts || 0) + 1,
          },
        }));
      }
    });
  };

  const retryFrameInspect = (obs: SpherexObservation) => {
    if (!searchResult) return;
    const key = renderKey(obs.id);
    setFrameErrorMap((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    void inspectObservation(obs, searchResult.query.raDeg, searchResult.query.decDeg, {
      silent: true,
    });
  };

  const retryFailedQueueObservations = () => {
    setPrepMap((prev) => {
      const next: Record<string, ObservationPrepRecord> = {};
      for (const [id, rec] of Object.entries(prev)) {
        if (rec.status !== 'failed' && rec.status !== 'timed-out') {
          next[id] = rec;
        }
      }
      return next;
    });
    setFrameErrorMap({});
    void startPreparationAndPlay(readyObservations.length < 2);
  };

  const handleSelectChallengeTarget = (target: ChallengeTarget) => {
    setObjectQuery(target.name);
    setRaInput(target.raInput);
    setDecInput(target.decInput);
    setActiveTargetLabel(target.name);
    executeCoordinateSearch(target.raInput, target.decInput, target.name);
  };

  const handleSampleTimeline = async () => {
    if (!searchResult || filteredObservations.length === 0) return;
    setIsSampling(true);
    const total = filteredObservations.length;
    const sampleCount = Math.min(8, total);
    const indices = new Set<number>();
    for (let i = 0; i < sampleCount; i++) {
      indices.add(Math.round((i * (total - 1)) / Math.max(1, sampleCount - 1)));
    }

    await Promise.all(
      Array.from(indices).map(async (idx) => {
        const obs = filteredObservations[idx];
        if (obs && !photometryMap[obs.id]) {
          await inspectObservation(obs, searchResult.query.raDeg, searchResult.query.decDeg, {
            silent: true,
          });
        }
      })
    );
    setIsSampling(false);
  };

  const activeInspect = activeObs ? fitsCache[renderKey(activeObs.id)] : undefined;
  const displayedInspect = activeInspect || lastDisplayedInspect;
  const activePrepRecord = activeObs ? prepMap[activeObs.id] : undefined;

  const obsA =
    filteredObservations.find((o) => o.id === compareIdA) || filteredObservations[0] || null;
  const obsB =
    filteredObservations.find((o) => o.id === compareIdB) ||
    filteredObservations[Math.min(1, filteredObservations.length - 1)] ||
    null;
  const inspectA = obsA ? fitsCache[renderKey(obsA.id)] : undefined;
  const inspectB = obsB ? fitsCache[renderKey(obsB.id)] : undefined;

  const fitsCanvasContent = (
    <div>
      {/* FITS Viewer Toolbar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Image stretch mode"
            value={stretch}
            onChange={(e) => {
              clearPlaybackTimer();
              cancelPrepQueue();
              setIsPlaying(false);
              setPrepCompleted(false);
              setPrepMap({});
              setStretch(e.target.value as 'asinh' | 'log' | 'linear');
            }}
            className="rounded border border-slate-700 bg-[#070B15] px-2 py-1 text-slate-200"
          >
            <option value="asinh">Asinh Stretch</option>
            <option value="log">Log Stretch</option>
            <option value="linear">Linear Stretch</option>
          </select>

          <select
            aria-label="Colormap"
            value={colormap}
            onChange={(e) => {
              clearPlaybackTimer();
              cancelPrepQueue();
              setIsPlaying(false);
              setPrepCompleted(false);
              setPrepMap({});
              setColormap(e.target.value as 'infrared' | 'cool' | 'viridis' | 'grayscale');
            }}
            className="rounded border border-slate-700 bg-[#070B15] px-2 py-1 text-slate-200"
          >
            <option value="infrared">Infrared Amber</option>
            <option value="cool">Cobalt Cyan</option>
            <option value="viridis">Viridis</option>
            <option value="grayscale">Grayscale</option>
          </select>

          <label className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-[#070B15] px-2.5 py-1 text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={subtractZodi}
              onChange={(e) => {
                clearPlaybackTimer();
                cancelPrepQueue();
                setIsPlaying(false);
                setPrepCompleted(false);
                setPrepMap({});
                setSubtractZodi(e.target.checked);
              }}
              className="accent-cyan-400"
            />
            <span>Subtract Zodiacal Model</span>
          </label>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoomScale((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
            aria-label="Zoom out"
            className="rounded border border-slate-700 bg-[#070B15] p-1.5 text-slate-300 hover:text-white cursor-pointer"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-10 text-center font-mono tabular-nums text-slate-300">
            {zoomScale}×
          </span>
          <button
            type="button"
            onClick={() => setZoomScale((z) => Math.min(3, Number((z + 0.5).toFixed(1))))}
            aria-label="Zoom in"
            className="rounded border border-slate-700 bg-[#070B15] p-1.5 text-slate-300 hover:text-white cursor-pointer"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* FITS Cutout Viewport — keeps last valid frame visible while loading the next */}
      <div className="relative flex h-[380px] items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-[#040710]">
        {displayedInspect ? (
          <div
            className="relative transition-transform duration-150 ease-out"
            style={{ transform: `scale(${zoomScale})` }}
          >
            <img
              key={activeObs?.id || 'empty'}
              src={displayedInspect.pngDataUrl}
              alt={`SPHEREx ${activeObs?.bandpassName} observation on ${activeObs?.obsDateDisplay}`}
              referrerPolicy="no-referrer"
              onLoad={() => setFrameImageSettledNonce((n) => n + 1)}
              className="h-[340px] w-[340px] cursor-crosshair object-contain [image-rendering:pixelated]"
            />
            {displayedInspect.photometry.targetPixelX !== null &&
              displayedInspect.photometry.targetPixelY !== null && (
                <div
                  aria-hidden="true"
                  title="WCS-projected target coordinate"
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${
                      (displayedInspect.photometry.targetPixelX / displayedInspect.stats.width) *
                      100
                    }%`,
                    top: `${
                      ((displayedInspect.stats.height -
                        1 -
                        displayedInspect.photometry.targetPixelY) /
                        displayedInspect.stats.height) *
                      100
                    }%`,
                  }}
                >
                  <div className="h-7 w-7 rounded-full border border-cyan-300/90" />
                  <div className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 -translate-y-2 bg-cyan-300/90" />
                  <div className="absolute bottom-0 left-1/2 h-2 w-px -translate-x-1/2 translate-y-2 bg-cyan-300/90" />
                  <div className="absolute left-0 top-1/2 h-px w-2 -translate-x-2 -translate-y-1/2 bg-cyan-300/90" />
                  <div className="absolute right-0 top-1/2 h-px w-2 translate-x-2 -translate-y-1/2 bg-cyan-300/90" />
                </div>
              )}
          </div>
        ) : singleLoading ? (
          <div className="flex flex-col items-center gap-2.5 px-4 text-center">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
            <p className="text-xs text-slate-300">
              Preparing astronomical observation from NASA/IPAC IRSA...
            </p>
          </div>
        ) : singleError ? (
          <div className="max-w-md px-4 text-center">
            <p className="text-sm font-medium text-amber-300">Observation Unavailable</p>
            <p className="mt-1 text-xs text-slate-400">{singleError}</p>
            {activeObs && (
              <button
                type="button"
                onClick={retrySingleObservation}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Retry Observation</span>
              </button>
            )}
          </div>
        ) : null}

        {/* Unobtrusive corner indicator if manually fetching a single uncached frame while keeping previous frame visible */}
        {singleLoading && displayedInspect && (
          <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded bg-slate-950/90 px-2.5 py-1 font-mono text-[11px] text-cyan-200">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Loading next observation...</span>
          </div>
        )}

        {((activePrepRecord &&
          (activePrepRecord.status === 'failed' || activePrepRecord.status === 'timed-out')) ||
          (singleError && displayedInspect)) &&
          !isPlaying &&
          !singleLoading && (
            <div className="absolute left-2.5 top-2.5 flex items-center gap-2 rounded border border-amber-500/40 bg-slate-950/90 px-2.5 py-1 text-[11px] text-amber-200">
              <span>
                Selected frame unavailable
                {activePrepRecord ? ` (${activePrepRecord.status})` : ''}; showing previous ready image.
              </span>
              {activeObs && (
                <button
                  type="button"
                  onClick={retrySingleObservation}
                  className="inline-flex items-center gap-1 rounded border border-cyan-500/50 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/25 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  <span>Retry</span>
                </button>
              )}
            </div>
          )}

        {activeObs && (
          <div className="pointer-events-none absolute bottom-2.5 left-2.5 rounded bg-slate-950/85 px-2.5 py-1 font-mono text-[11px] text-slate-200">
            {activeObs.obsDateDisplay} · {activeObs.bandpassName}
            {activeObs.emMinUm && activeObs.emMaxUm
              ? ` (${activeObs.emMinUm.toFixed(2)}–${activeObs.emMaxUm.toFixed(2)} µm)`
              : ''}
          </div>
        )}
        {displayedInspect && (
          <div className="pointer-events-none absolute right-2.5 top-2.5 rounded bg-slate-950/85 px-2.5 py-1 font-mono text-[11px] text-slate-300">
            {displayedInspect.stats.width}×{displayedInspect.stats.height} px ·{' '}
            {displayedInspect.stats.zodiSubtracted ? 'Zodi-subtracted' : 'Total flux'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <section id="explore" className="border-b border-slate-800/80 bg-[#080D1A] py-14 sm:py-20">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="max-w-3xl">
          <p className="text-xs font-medium tracking-wider text-cyan-300">
            Interactive Sky Exploration Workspace
          </p>
          <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-white sm:text-3xl [text-wrap:balance]">
            Search Sky Coordinates &amp; Explore SPHEREx Through Time
          </h2>
          <p className="mt-2.5 text-sm leading-relaxed text-slate-300 sm:text-base">
            Select a challenge target or enter Right Ascension and Declination to retrieve genuine
            SPHEREx DR1 exposures from NASA/IPAC IRSA and inspect them alongside Aladin Lite.
          </p>
        </div>

        {/* Supported Challenge Targets Strip */}
        <div className="mt-8">
          <p className="mb-3 text-xs font-medium text-slate-400">
            Challenge Test Targets (Select to populate coordinates &amp; load observations)
          </p>
          {targets.length === 0 && (targetsError || !targetsLoading) ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/35 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>
                  {targetsError || 'Could not load challenge targets from the data API.'}
                </span>
              </div>
              {onRetryTargets && (
                <button
                  type="button"
                  disabled={targetsLoading}
                  onClick={onRetryTargets}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${targetsLoading ? 'animate-spin' : ''}`} />
                  <span>Retry Targets</span>
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {targets.map((target) => {
                const isSelected = activeTargetLabel === target.name;
                return (
                  <button
                    key={target.id}
                    type="button"
                    onClick={() => handleSelectChallengeTarget(target)}
                    className={`flex flex-col justify-between rounded-xl border p-3.5 text-left transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-cyan-400/80 bg-[#101B33]'
                        : 'border-slate-800 bg-[#0C1324] hover:border-slate-700 hover:bg-[#0F172B]'
                    }`}
                  >
                    <div>
                      <p className="font-display text-sm font-semibold text-white">{target.name}</p>
                      <p className="mt-0.5 text-[11px] text-cyan-300/90">{target.category}</p>
                      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-400">
                        {target.summary}
                      </p>
                    </div>
                    <p className="mt-3 border-t border-slate-800/80 pt-2 font-mono tabular-nums text-[10px] text-slate-400">
                      {target.raInput} · {target.decInput}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Coordinate & Object Name Search Panel */}
        <div className="mt-6 rounded-xl border border-slate-800 bg-[#0B1222] p-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-4">
              <label
                htmlFor="object-name-input"
                className="block text-xs font-medium text-slate-300"
              >
                Optional: Search by Celestial Object Name
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="object-name-input"
                  type="text"
                  value={objectQuery}
                  onChange={(e) => setObjectQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleResolveObjectName();
                  }}
                  placeholder="e.g. Barnard's Star, M31, RW Aur"
                  className="w-full rounded-lg border border-slate-700 bg-[#070B15] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleResolveObjectName()}
                  disabled={searchLoading || !objectQuery.trim()}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                >
                  Resolve
                </button>
              </div>
            </div>

            <div className="lg:col-span-3">
              <label htmlFor="ra-input" className="block text-xs font-medium text-slate-300">
                Right Ascension (RA, ICRS)
              </label>
              <input
                id="ra-input"
                type="text"
                value={raInput}
                onChange={(e) => setRaInput(e.target.value)}
                placeholder="08h55m10.831s or 133.795"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-[#070B15] px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
              />
            </div>

            <div className="lg:col-span-3">
              <label htmlFor="dec-input" className="block text-xs font-medium text-slate-300">
                Declination (Dec, ICRS)
              </label>
              <input
                id="dec-input"
                type="text"
                value={decInput}
                onChange={(e) => setDecInput(e.target.value)}
                placeholder="-07d14m42.53s or -7.245"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-[#070B15] px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
              />
            </div>

            <div className="flex items-end gap-2 lg:col-span-2">
              <div className="w-24">
                <label htmlFor="radius-select" className="block text-xs font-medium text-slate-300">
                  Radius
                </label>
                <select
                  id="radius-select"
                  value={radiusDeg}
                  onChange={(e) => setRadiusDeg(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-[#070B15] px-2.5 py-2 font-mono text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
                >
                  <option value="0.05">0.05°</option>
                  <option value="0.08">0.08°</option>
                  <option value="0.15">0.15°</option>
                </select>
              </div>

              <button
                type="button"
                disabled={searchLoading}
                onClick={() => executeCoordinateSearch(raInput, decInput, activeTargetLabel)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-60 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Search className="h-4 w-4" />
                <span>{searchLoading ? 'Searching...' : 'Search'}</span>
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-3">
            <button
              type="button"
              onClick={() => setShowCoordHelp((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-cyan-300 cursor-pointer"
            >
              <HelpCircle className="h-3.5 w-3.5" />
              <span>What are Right Ascension (RA) and Declination (Dec)?</span>
            </button>

            {searchResult && (
              <p className="font-mono text-xs text-slate-400">
                {searchResult.query.resolvedName ? `${searchResult.query.resolvedName} · ` : ''}
                {searchResult.query.raHms}, {searchResult.query.decDms} ·{' '}
                <span className="text-cyan-300 tabular-nums">
                  {searchResult.totalCount} real SPHEREx DR1 observations
                </span>
              </p>
            )}
          </div>

          {showCoordHelp && (
            <div className="mt-3 rounded-lg border border-slate-800 bg-[#080D19] p-4 text-xs leading-relaxed text-slate-300">
              <p>
                <strong className="text-white">Right Ascension (RA)</strong> is the celestial
                equivalent of longitude on Earth, measured in hours, minutes, and seconds (e.g.,{' '}
                <code className="font-mono text-cyan-300">08h55m10.831s</code>) or degrees (0°–360°).{' '}
                <strong className="text-white">Declination (Dec)</strong> is like latitude north or
                south of the celestial equator, measured in degrees from -90° to +90° (e.g.,{' '}
                <code className="font-mono text-cyan-300">-07d14m42.53s</code>). Both formats—sexagesimal
                or decimal degrees—work here.
              </p>
            </div>
          )}

          {searchResult?.sourceStatus === 'live-cube-fallback' && !searchError && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cyan-500/35 bg-cyan-950/25 p-3.5 text-xs text-cyan-100">
              <div className="flex items-start gap-2.5 min-w-0">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                <div>
                  <p className="font-medium text-cyan-200">
                    Serving NASA/IPAC SPHEREx DR1 All-Sky Spectral Cube
                  </p>
                  <p className="mt-0.5 text-cyan-100/85">
                    {searchResult.noticeMessage ||
                      'Live per-epoch SIA2 metadata endpoint is temporarily returning 502; serving calibrated DR1 spectral cube cutouts across D1–D6.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={searchLoading}
                onClick={handleRetrySearch}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/50 bg-cyan-500/15 px-3.5 py-1.5 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/25 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${searchLoading ? 'animate-spin' : ''}`} />
                <span>Retry Live SIA2</span>
              </button>
            </div>
          )}

          {searchError && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-500/40 bg-rose-950/30 p-3.5 text-xs text-rose-200"
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <div>
                  <p className="font-medium">Coordinate / Archive Notice</p>
                  <p className="mt-0.5 text-rose-200/90">{searchError}</p>
                </div>
              </div>
              <button
                type="button"
                disabled={searchLoading}
                onClick={handleRetrySearch}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${searchLoading ? 'animate-spin' : ''}`} />
                <span>Retry</span>
              </button>
            </div>
          )}
        </div>

        {/* Empty Results Guidance */}
        {searchResult && searchResult.sourceStatus === 'empty' && !searchLoading && (
          <div className="mt-6 rounded-xl border border-slate-800 bg-[#0B1222] p-8 text-center">
            <h3 className="font-display text-lg font-semibold text-white">
              No SPHEREx DR1 Observations Found at These Coordinates
            </h3>
            <p className="mx-auto mt-2 max-w-lg text-sm text-slate-400">
              IRSA returned 0 matching exposures within {radiusDeg}° of {searchResult.query.raHms},{' '}
              {searchResult.query.decDms}. Try widening the search radius to 0.15° or selecting one
              of the verified challenge targets above.
            </p>
          </div>
        )}

        {/* Main Workspace Stage */}
        {(searchLoading || (searchResult && searchResult.observations.length > 0)) && (
          <div className="mt-6">
            {/* Mode Bar & Band Filter */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-xl border border-b-0 border-slate-800 bg-[#0C1426] px-4 py-3">
              <div className="flex flex-wrap items-center gap-1 rounded-lg bg-[#070B15] p-1">
                <button
                  type="button"
                  onClick={() => setViewMode('split')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'split'
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  <span>FITS + Aladin Lite</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('single')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'single'
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span>Single Cutout</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('aladin')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'aladin'
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Globe className="h-3.5 w-3.5" />
                  <span>Aladin Lite Full</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('side-by-side')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'side-by-side'
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Columns className="h-3.5 w-3.5" />
                  <span>Compare Two</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('compare-timelapse');
                    if (readyObservations.length >= 2) {
                      setIsPlaying(true);
                    } else if (!isPreparingQueue && !prepCompleted && filteredObservations.length >= 2) {
                      void startPreparationAndPlay(true);
                    }
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'compare-timelapse'
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Compare vs Time-Lapse</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('overlay')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'overlay'
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Layers className="h-3.5 w-3.5" />
                  <span>Overlay Blend</span>
                </button>
              </div>

              {/* Detector Band Filter */}
              <div className="flex items-center gap-2">
                <label htmlFor="band-filter" className="text-xs text-slate-400">
                  Band Filter:
                </label>
                <select
                  id="band-filter"
                  value={bandFilter}
                  onChange={(e) => {
                    cancelPrepQueue();
                    clearPlaybackTimer();
                    setIsPlaying(false);
                    setPrepCompleted(false);
                    setPrepMap({});
                    setShowFailedDetails(false);
                    setBandFilter(e.target.value);
                    setSelectedObsId(null);
                  }}
                  className="rounded-lg border border-slate-700 bg-[#070B15] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                >
                  {availableBands.map((b) => (
                    <option key={b} value={b}>
                      {b} (
                      {
                        (searchResult?.observations || []).filter((o) => o.bandpassName === b)
                          .length
                      }
                      )
                    </option>
                  ))}
                  <option value="ALL">
                    All Bands ({searchResult?.observations.length || 0})
                  </option>
                </select>
              </div>
            </div>

            {/* Split Stage: Viewer (Left 8 cols) + Metadata Inspector (Right 4 cols) */}
            <div className="grid grid-cols-1 border border-slate-800 bg-[#0B1222] lg:grid-cols-12">
              <div className="border-b border-slate-800 p-4 sm:p-5 lg:col-span-8 lg:border-r lg:border-b-0">
                {searchLoading ? (
                  <div className="flex h-[430px] flex-col items-center justify-center gap-3 rounded-lg border border-slate-800 bg-[#050811]">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
                    <p className="text-sm text-slate-300">
                      Querying NASA/IPAC IRSA SIA2 for SPHEREx observations...
                    </p>
                  </div>
                ) : viewMode === 'split' && searchResult ? (
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <div>{fitsCanvasContent}</div>
                    <div>
                      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
                        <span className="font-medium text-slate-200">
                          Aladin Lite v3 Sky Context
                        </span>
                        <span className="font-mono text-[11px]">Full-Sky + SPHEREx Highlight</span>
                      </div>
                      <AladinViewer
                        raDeg={searchResult.query.raDeg}
                        decDeg={searchResult.query.decDeg}
                        observation={activeObs}
                        fallbackPreviewUrl={displayedInspect?.pngDataUrl || null}
                        heightClass="h-[322px]"
                      />
                    </div>
                  </div>
                ) : viewMode === 'single' ? (
                  fitsCanvasContent
                ) : viewMode === 'aladin' && searchResult ? (
                  <AladinViewer
                    raDeg={searchResult.query.raDeg}
                    decDeg={searchResult.query.decDeg}
                    observation={activeObs}
                    fallbackPreviewUrl={displayedInspect?.pngDataUrl || null}
                    heightClass="h-[420px]"
                  />
                ) : viewMode === 'side-by-side' ? (
                  <div>
                    {/* Observation A / B Selectors + Highlight Differences Toggle */}
                    <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
                      <div className="sm:col-span-4">
                        <label htmlFor="compare-a-select" className="block text-[11px] text-slate-400">
                          Observation A
                        </label>
                        <select
                          id="compare-a-select"
                          value={obsA?.id || ''}
                          onChange={(e) => setCompareIdA(e.target.value)}
                          className="mt-1 w-full rounded border border-slate-700 bg-[#070B15] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                        >
                          {filteredObservations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.obsDateDisplay.slice(0, 16)} · {o.bandpassName}
                              {o.emCenterUm ? ` (${o.emCenterUm.toFixed(2)} µm)` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="sm:col-span-4">
                        <label htmlFor="compare-b-select" className="block text-[11px] text-slate-400">
                          Observation B
                        </label>
                        <select
                          id="compare-b-select"
                          value={obsB?.id || ''}
                          onChange={(e) => setCompareIdB(e.target.value)}
                          className="mt-1 w-full rounded border border-slate-700 bg-[#070B15] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                        >
                          {filteredObservations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.obsDateDisplay.slice(0, 16)} · {o.bandpassName}
                              {o.emCenterUm ? ` (${o.emCenterUm.toFixed(2)} µm)` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="sm:col-span-4 flex items-center justify-end">
                        <button
                          type="button"
                          onClick={() => setHighlightDiff((v) => !v)}
                          aria-pressed={highlightDiff}
                          className={`inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                            highlightDiff
                              ? 'border-cyan-400/80 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                              : 'border-slate-700 bg-[#070B15] text-slate-300 hover:border-slate-600 hover:text-white'
                          }`}
                        >
                          <ScanSearch className="h-3.5 w-3.5" />
                          <span>{highlightDiff ? 'Highlight Differences: On' : 'Highlight Differences: Off'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Difference Highlight Controls Bar */}
                    {highlightDiff && (
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#070B15] px-3 py-2.5 text-xs">
                        <div className="flex flex-wrap items-center gap-4">
                          <div className="flex items-center gap-2">
                            <label
                              htmlFor="diff-sigma-range"
                              className="text-[11px] text-slate-300 whitespace-nowrap"
                            >
                              Sensitivity:{' '}
                              <span className="font-mono tabular-nums text-cyan-300">
                                {diffThresholdSigma.toFixed(1)}σ
                              </span>
                            </label>
                            <input
                              id="diff-sigma-range"
                              type="range"
                              min={1.5}
                              max={8.0}
                              step={0.5}
                              value={diffThresholdSigma}
                              onChange={(e) => setDiffThresholdSigma(Number(e.target.value))}
                              className="w-24 accent-cyan-400 cursor-pointer"
                            />
                          </div>

                          <div className="flex items-center gap-2">
                            <label
                              htmlFor="diff-opacity-range"
                              className="text-[11px] text-slate-300 whitespace-nowrap"
                            >
                              Highlight Opacity:{' '}
                              <span className="font-mono tabular-nums text-cyan-300">
                                {diffOverlayOpacity}%
                              </span>
                            </label>
                            <input
                              id="diff-opacity-range"
                              type="range"
                              min={20}
                              max={100}
                              step={5}
                              value={diffOverlayOpacity}
                              onChange={(e) => setDiffOverlayOpacity(Number(e.target.value))}
                              className="w-20 accent-cyan-400 cursor-pointer"
                            />
                          </div>

                          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer whitespace-nowrap">
                            <input
                              type="checkbox"
                              checked={diffMatchBackground}
                              onChange={(e) => setDiffMatchBackground(e.target.checked)}
                              className="accent-cyan-400"
                            />
                            <span>Match Sky Background</span>
                          </label>

                          <div className="flex items-center gap-1.5">
                            <label
                              htmlFor="diff-align-select"
                              className="text-[11px] text-slate-400 whitespace-nowrap"
                            >
                              Align:
                            </label>
                            <select
                              id="diff-align-select"
                              value={diffAlignMode}
                              onChange={(e) => setDiffAlignMode(e.target.value as 'wcs' | 'pixel')}
                              className="rounded border border-slate-700 bg-[#050811] px-2 py-1 font-mono text-[11px] text-slate-200"
                            >
                              <option value="wcs">Sky WCS</option>
                              <option value="pixel">Pixel Grid</option>
                            </select>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 font-mono text-[11px]">
                          <span className="inline-flex items-center gap-1.5 text-cyan-300">
                            <span className="inline-block h-2.5 w-2.5 rounded-xs border border-cyan-300 bg-cyan-400/40" />
                            <span>Brighter in A</span>
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-rose-300">
                            <span className="inline-block h-2.5 w-2.5 rounded-xs border border-rose-400 bg-rose-400/40" />
                            <span>Brighter in B</span>
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Frame A & Frame B Side-by-Side */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {[
                        {
                          label: 'Frame A',
                          isA: true,
                          obs: obsA,
                          inspect: inspectA,
                          overlayUrl: diffResult?.overlayADataUrl,
                        },
                        {
                          label: 'Frame B',
                          isA: false,
                          obs: obsB,
                          inspect: inspectB,
                          overlayUrl: diffResult?.overlayBDataUrl,
                        },
                      ].map((slot) => (
                        <div
                          key={slot.label}
                          className="flex flex-col rounded-lg border border-slate-800 bg-[#050811] p-3"
                        >
                          <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-slate-300">
                            <span className="font-semibold text-slate-100">{slot.label}</span>
                            <span>{slot.obs?.bandpassName}</span>
                          </div>
                          <div className="relative flex h-64 items-center justify-center overflow-hidden rounded bg-black p-1">
                            {slot.inspect ? (
                              <div
                                className="relative"
                                style={{
                                  width: `min(100%, calc(15.5rem * ${slot.inspect.stats.width} / ${slot.inspect.stats.height}))`,
                                  aspectRatio: `${slot.inspect.stats.width} / ${slot.inspect.stats.height}`,
                                }}
                              >
                                <img
                                  src={slot.inspect.pngDataUrl}
                                  alt={`${slot.label} SPHEREx observation`}
                                  referrerPolicy="no-referrer"
                                  className="block h-full w-full [image-rendering:pixelated]"
                                />
                                {highlightDiff && diffResult && slot.overlayUrl && (
                                  <img
                                    src={slot.overlayUrl}
                                    alt={`${slot.label} highlighted differences`}
                                    referrerPolicy="no-referrer"
                                    style={{ opacity: diffOverlayOpacity / 100 }}
                                    className="pointer-events-none absolute inset-0 block h-full w-full [image-rendering:pixelated] transition-opacity duration-150"
                                  />
                                )}
                                {highlightDiff &&
                                  diffResult &&
                                  diffResult.hotspots.map((hs) => {
                                    const hx = slot.isA ? hs.xA : hs.xB;
                                    const hy = slot.isA ? hs.yA : hs.yB;
                                    const w = slot.inspect!.stats.width;
                                    const h = slot.inspect!.stats.height;
                                    if (hx < 0 || hx >= w || hy < 0 || hy >= h) return null;
                                    const leftPct = ((hx + 0.5) / w) * 100;
                                    const topPct = ((h - 0.5 - hy) / h) * 100;
                                    const isActiveHs = selectedHotspotId === hs.id;
                                    return (
                                      <button
                                        key={hs.id}
                                        type="button"
                                        onClick={() =>
                                          setSelectedHotspotId((cur) =>
                                            cur === hs.id ? null : hs.id
                                          )
                                        }
                                        title={`Region #${hs.id}: ${
                                          hs.dominantIn === 'A' ? 'Brighter in A' : 'Brighter in B'
                                        } · Peak Δ ${hs.peakDeltaMJySr >= 0 ? '+' : ''}${hs.peakDeltaMJySr.toFixed(4)} MJy/sr (${hs.peakSigma}σ)`}
                                        style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                                        className={`absolute -translate-x-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px] font-semibold transition-transform cursor-pointer ${
                                          isActiveHs
                                            ? 'z-20 scale-125 border-white bg-amber-400 text-slate-950'
                                            : hs.dominantIn === 'A'
                                              ? 'z-10 border-cyan-300 bg-slate-950/85 text-cyan-200 hover:scale-110'
                                              : 'z-10 border-rose-400 bg-slate-950/85 text-rose-200 hover:scale-110'
                                        }`}
                                      >
                                        {hs.id}
                                      </button>
                                    );
                                  })}
                              </div>
                            ) : slot.obs && frameErrorMap[renderKey(slot.obs.id)] ? (
                              <div className="flex flex-col items-center gap-2 px-3 text-center">
                                <p className="text-xs font-medium text-amber-300">
                                  Frame Failed to Load
                                </p>
                                <p className="line-clamp-2 text-[11px] text-slate-400">
                                  {frameErrorMap[renderKey(slot.obs.id)]}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => retryFrameInspect(slot.obs!)}
                                  className="inline-flex items-center gap-1 rounded bg-cyan-500 px-3 py-1 text-[11px] font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                                >
                                  <RefreshCw className="h-3 w-3" />
                                  <span>Retry</span>
                                </button>
                              </div>
                            ) : (
                              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
                            )}
                            {highlightDiff && diffLoading && (
                              <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded bg-slate-950/90 px-2 py-1 font-mono text-[10px] text-cyan-200">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                <span>Comparing...</span>
                              </div>
                            )}
                          </div>
                          <div className="mt-2 font-mono text-[11px] text-slate-400">
                            <p>{slot.obs?.obsDateDisplay}</p>
                            <p className="tabular-nums">
                              Net flux:{' '}
                              {slot.inspect?.photometry.netSurfaceBrightness !== null &&
                              slot.inspect?.photometry.netSurfaceBrightness !== undefined
                                ? `${slot.inspect.photometry.netSurfaceBrightness.toFixed(4)} MJy/sr`
                                : slot.obs && frameErrorMap[renderKey(slot.obs.id)]
                                  ? 'Unavailable'
                                  : 'Loading...'}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Same observation / Error notices */}
                    {highlightDiff && obsA && obsB && obsA.id === obsB.id && (
                      <div className="mt-3 rounded-lg border border-slate-800 bg-[#070B15] px-3.5 py-2.5 text-xs text-slate-300">
                        Frame A and Frame B point to the same observation. Select two different
                        observations above to highlight differences.
                      </div>
                    )}

                    {highlightDiff && diffError && (
                      <div
                        role="alert"
                        className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-950/30 px-3.5 py-2.5 text-xs text-rose-200"
                      >
                        <div className="flex items-start gap-2">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                          <span>{diffError}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setDiffRetryNonce((n) => n + 1)}
                          className="inline-flex items-center gap-1 rounded bg-cyan-500 px-3 py-1 text-[11px] font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <RefreshCw className="h-3 w-3" />
                          <span>Retry</span>
                        </button>
                      </div>
                    )}

                    {/* Aligned Difference Map (B - A) & Detected Change Regions */}
                    {highlightDiff && diffResult && obsA && obsB && obsA.id !== obsB.id && (
                      <div className="mt-4 rounded-lg border border-slate-800 bg-[#060A14] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                          <div>
                            <h4 className="font-display text-sm font-semibold text-white">
                              Aligned Difference Map (Frame B − Frame A)
                            </h4>
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {diffResult.alignmentMode === 'wcs'
                                ? 'Reprojected onto Frame A using astrometric Sky WCS coordinates.'
                                : 'Compared directly on detector pixel coordinates.'}{' '}
                              Unchanged sky remains dark; brighter-in-A regions glow cyan and
                              brighter-in-B regions glow rose.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono tabular-nums text-[11px] text-slate-300">
                            <span>
                              Changed:{' '}
                              <strong className="text-white">
                                {(diffResult.changedFraction * 100).toFixed(2)}%
                              </strong>{' '}
                              ({diffResult.changedPixelCount}/{diffResult.validOverlapPixelCount} px)
                            </span>
                            <span aria-hidden="true" className="text-slate-600">
                              ·
                            </span>
                            <span>
                              Overlap: {(diffResult.overlapFraction * 100).toFixed(1)}%
                            </span>
                            <span aria-hidden="true" className="text-slate-600">
                              ·
                            </span>
                            <span>1σ = {diffResult.noiseSigma.toFixed(4)} MJy/sr</span>
                          </div>
                        </div>

                        {diffResult.validOverlapPixelCount === 0 ? (
                          <div className="mt-3 rounded border border-amber-500/35 bg-amber-950/20 px-3.5 py-3 text-xs text-amber-200">
                            No overlapping sky pixels were found between Frame A and Frame B under{' '}
                            {diffResult.alignmentMode === 'wcs' ? 'Sky WCS' : 'Pixel Grid'}{' '}
                            alignment. Try switching Align to Pixel Grid or choosing two exposures
                            covering the same field.
                          </div>
                        ) : (
                          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12">
                            {/* Difference Image */}
                            <div className="md:col-span-5">
                              <div className="relative flex h-56 items-center justify-center overflow-hidden rounded border border-slate-800 bg-black p-1">
                                <div
                                  className="relative"
                                  style={{
                                    width: `min(100%, calc(13.5rem * ${diffResult.widthA} / ${diffResult.heightA}))`,
                                    aspectRatio: `${diffResult.widthA} / ${diffResult.heightA}`,
                                  }}
                                >
                                  <img
                                    src={diffResult.diffMapDataUrl}
                                    alt="Aligned difference map B minus A"
                                    referrerPolicy="no-referrer"
                                    className="block h-full w-full [image-rendering:pixelated]"
                                  />
                                  {diffResult.hotspots.map((hs) => {
                                    const leftPct = ((hs.xA + 0.5) / diffResult.widthA) * 100;
                                    const topPct =
                                      ((diffResult.heightA - 0.5 - hs.yA) / diffResult.heightA) *
                                      100;
                                    const isActiveHs = selectedHotspotId === hs.id;
                                    return (
                                      <button
                                        key={hs.id}
                                        type="button"
                                        onClick={() =>
                                          setSelectedHotspotId((cur) =>
                                            cur === hs.id ? null : hs.id
                                          )
                                        }
                                        style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                                        className={`absolute -translate-x-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px] font-semibold transition-transform cursor-pointer ${
                                          isActiveHs
                                            ? 'z-20 scale-125 border-white bg-amber-400 text-slate-950'
                                            : hs.dominantIn === 'A'
                                              ? 'z-10 border-cyan-300 bg-slate-950/85 text-cyan-200 hover:scale-110'
                                              : 'z-10 border-rose-400 bg-slate-950/85 text-rose-200 hover:scale-110'
                                        }`}
                                      >
                                        {hs.id}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="mt-2 flex items-center justify-between font-mono tabular-nums text-[10px] text-slate-400">
                                <span className="text-cyan-300">
                                  A &gt; B: {diffResult.brighterInACount} px
                                </span>
                                <span>Peak |Δ|: {diffResult.maxAbsDeltaMJySr.toFixed(3)} MJy/sr</span>
                                <span className="text-rose-300">
                                  B &gt; A: {diffResult.brighterInBCount} px
                                </span>
                              </div>
                            </div>

                            {/* Quantitative Summary & Top Difference Hotspots */}
                            <div className="flex flex-col justify-between md:col-span-7">
                              <div>
                                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                                  <div className="rounded border border-slate-800 bg-[#090F1E] px-2.5 py-2">
                                    <p className="text-[10px] text-slate-400">
                                      {Math.abs(obsB.tMinMjd - obsA.tMinMjd) < 1e-6 &&
                                      obsA.emCenterUm &&
                                      obsB.emCenterUm
                                        ? 'Wavelength Shift (B − A)'
                                        : 'Elapsed Time (B − A)'}
                                    </p>
                                    <p className="mt-0.5 font-mono tabular-nums text-xs font-medium text-slate-100">
                                      {(() => {
                                        const deltaDays = obsB.tMinMjd - obsA.tMinMjd;
                                        if (
                                          Math.abs(deltaDays) < 1e-6 &&
                                          obsA.emCenterUm &&
                                          obsB.emCenterUm
                                        ) {
                                          const dLam = obsB.emCenterUm - obsA.emCenterUm;
                                          return `${dLam >= 0 ? '+' : ''}${dLam.toFixed(3)} µm`;
                                        }
                                        if (Math.abs(deltaDays) < 1) {
                                          return `${(deltaDays * 24).toFixed(1)} hrs`;
                                        }
                                        return `${deltaDays >= 0 ? '+' : ''}${deltaDays.toFixed(2)} d`;
                                      })()}
                                    </p>
                                  </div>
                                  <div className="rounded border border-slate-800 bg-[#090F1E] px-2.5 py-2">
                                    <p className="text-[10px] text-slate-400">Target Aperture Δ</p>
                                    <p className="mt-0.5 font-mono tabular-nums text-xs font-medium text-slate-100">
                                      {inspectA?.photometry.netSurfaceBrightness !== null &&
                                      inspectA?.photometry.netSurfaceBrightness !== undefined &&
                                      inspectB?.photometry.netSurfaceBrightness !== null &&
                                      inspectB?.photometry.netSurfaceBrightness !== undefined
                                        ? (() => {
                                            const d =
                                              inspectB.photometry.netSurfaceBrightness -
                                              inspectA.photometry.netSurfaceBrightness;
                                            return `${d >= 0 ? '+' : ''}${d.toFixed(4)} MJy/sr`;
                                          })()
                                        : '—'}
                                    </p>
                                  </div>
                                  <div className="rounded border border-slate-800 bg-[#090F1E] px-2.5 py-2 col-span-2 sm:col-span-1">
                                    <p className="text-[10px] text-slate-400">Median Sky Offset</p>
                                    <p className="mt-0.5 font-mono tabular-nums text-xs font-medium text-slate-100">
                                      {diffResult.medianBackgroundOffset >= 0 ? '+' : ''}
                                      {diffResult.medianBackgroundOffset.toFixed(4)} MJy/sr
                                    </p>
                                  </div>
                                </div>

                                <div className="mt-3">
                                  <p className="text-[11px] font-medium text-slate-300">
                                    Detected Difference Regions (click to locate on A &amp; B)
                                  </p>
                                  {diffResult.hotspots.length === 0 ? (
                                    <p className="mt-1.5 rounded border border-slate-800/80 bg-[#090F1E] px-3 py-2 text-xs text-slate-400">
                                      No pixels exceed {diffResult.thresholdSigma.toFixed(1)}σ.
                                      Lower the sensitivity threshold to inspect subtler variations.
                                    </p>
                                  ) : (
                                    <div className="mt-1.5 space-y-1.5">
                                      {diffResult.hotspots.map((hs) => {
                                        const isActiveHs = selectedHotspotId === hs.id;
                                        return (
                                          <button
                                            key={hs.id}
                                            type="button"
                                            onClick={() =>
                                              setSelectedHotspotId((cur) =>
                                                cur === hs.id ? null : hs.id
                                              )
                                            }
                                            className={`flex w-full items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors cursor-pointer ${
                                              isActiveHs
                                                ? 'border-amber-400/80 bg-amber-500/10 text-white'
                                                : 'border-slate-800 bg-[#090F1E] text-slate-300 hover:border-slate-700'
                                            }`}
                                          >
                                            <span className="flex items-center gap-2 min-w-0">
                                              <span
                                                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                                                  hs.dominantIn === 'A'
                                                    ? 'bg-cyan-500/20 text-cyan-300'
                                                    : 'bg-rose-500/20 text-rose-300'
                                                }`}
                                              >
                                                {hs.id}
                                              </span>
                                              <span className="truncate">
                                                {hs.dominantIn === 'A'
                                                  ? 'Brighter in A'
                                                  : 'Brighter in B'}{' '}
                                                · {hs.pixelArea} px
                                                {hs.raDeg !== null && hs.decDeg !== null
                                                  ? ` · (${hs.raDeg.toFixed(4)}°, ${hs.decDeg.toFixed(4)}°)`
                                                  : ` · px (${hs.xA.toFixed(1)}, ${hs.yA.toFixed(1)})`}
                                              </span>
                                            </span>
                                            <span className="shrink-0 tabular-nums text-slate-200">
                                              {hs.peakDeltaMJySr >= 0 ? '+' : ''}
                                              {hs.peakDeltaMJySr.toFixed(3)} ({hs.peakSigma.toFixed(1)}
                                              σ)
                                            </span>
                                          </button>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <p className="mt-3 text-xs text-slate-400">
                      {obsA && obsB && obsA.bandpassName !== obsB.bandpassName
                        ? `Band mismatch notice: Frame A (${obsA.bandpassName}) and Frame B (${obsB.bandpassName}) cover different wavelengths, so highlighted differences include spectral energy distribution changes in addition to temporal motion or variability.`
                        : 'Visual comparison: Highlighted regions mark statistically significant flux or positional shifts between Frame A and Frame B after aligning their sky coordinates.'}
                    </p>
                  </div>
                ) : viewMode === 'compare-timelapse' ? (
                  <div>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="font-display text-sm font-semibold text-white">
                          Compare Reference vs Time-Lapse
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          Choose a fixed reference image in Column 1 while Column 2 runs the
                          chronological time-lapse automatically.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={
                          filteredObservations.length <= 1 ||
                          (prepCompleted && readyObservations.length < 2)
                        }
                        onClick={handleToggleTimelapse}
                        className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        {isPreparingQueue ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Preparing ({prepSummary.ready}/{prepSummary.total})...</span>
                          </>
                        ) : isPlaying ? (
                          <>
                            <Pause className="h-3.5 w-3.5" />
                            <span>Pause Column 2</span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5" />
                            <span>Play Time-Lapse</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {/* Column 1: Fixed Reference Selector */}
                      <div className="flex flex-col rounded-lg border border-slate-800 bg-[#050811] p-3">
                        <label
                          htmlFor="compare-ref-select"
                          className="block text-[11px] font-medium text-cyan-300"
                        >
                          Column 1 · Fixed Reference Picture
                        </label>
                        <select
                          id="compare-ref-select"
                          value={obsA?.id || ''}
                          onChange={(e) => setCompareIdA(e.target.value)}
                          className="mt-1.5 mb-2.5 w-full rounded border border-slate-700 bg-[#070B15] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                        >
                          {filteredObservations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.obsDateDisplay.slice(0, 16)} · {o.bandpassName}
                              {o.emCenterUm ? ` (${o.emCenterUm.toFixed(2)} µm)` : ''}
                            </option>
                          ))}
                        </select>

                        <div className="flex h-64 items-center justify-center overflow-hidden rounded bg-black">
                          {inspectA ? (
                            <img
                              src={inspectA.pngDataUrl}
                              alt={`Reference SPHEREx observation ${obsA?.obsId}`}
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-contain [image-rendering:pixelated]"
                            />
                          ) : obsA && frameErrorMap[renderKey(obsA.id)] ? (
                            <div className="flex flex-col items-center gap-2 px-3 text-center">
                              <p className="text-xs font-medium text-amber-300">Reference Frame Failed</p>
                              <button
                                type="button"
                                onClick={() => retryFrameInspect(obsA)}
                                className="inline-flex items-center gap-1 rounded bg-cyan-500 px-3 py-1 text-[11px] font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                              >
                                <RefreshCw className="h-3 w-3" />
                                <span>Retry</span>
                              </button>
                            </div>
                          ) : (
                            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
                          )}
                        </div>

                        <div className="mt-2 font-mono text-[11px] text-slate-400">
                          <p>{obsA?.obsDateDisplay}</p>
                          <p>
                            Reference flux:{' '}
                            {inspectA?.photometry.netSurfaceBrightness !== null &&
                            inspectA?.photometry.netSurfaceBrightness !== undefined
                              ? `${inspectA.photometry.netSurfaceBrightness.toFixed(4)} MJy/sr`
                              : 'Loading...'}
                          </p>
                        </div>
                      </div>

                      {/* Column 2: Automatic Time-Lapse Stream */}
                      <div className="flex flex-col rounded-lg border border-slate-800 bg-[#050811] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-amber-300">
                            Column 2 · Live Time-Lapse ({isPlaying ? 'Playing' : isPreparingQueue ? 'Preparing' : 'Ready'})
                          </span>
                          <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                            {readyObservations.length > 0
                              ? `Frame ${activeReadyIndex >= 0 ? activeReadyIndex + 1 : 1}/${readyObservations.length}`
                              : `${prepSummary.ready}/${prepSummary.total} prepared`}
                          </span>
                        </div>

                        <div className="mt-1.5 mb-2.5 rounded border border-slate-800 bg-[#070B15] px-2.5 py-1.5 font-mono text-xs text-slate-200 truncate">
                          {activeObs
                            ? `${activeObs.obsDateDisplay.slice(0, 16)} · ${activeObs.bandpassName}`
                            : 'Waiting for observation...'}
                        </div>

                        <div className="flex h-64 items-center justify-center overflow-hidden rounded bg-black">
                          {displayedInspect ? (
                            <img
                              key={activeObs?.id || 'compare-tl-empty'}
                              src={displayedInspect.pngDataUrl}
                              alt={`Time-lapse SPHEREx frame ${activeObs?.obsId}`}
                              referrerPolicy="no-referrer"
                              onLoad={() => setFrameImageSettledNonce((n) => n + 1)}
                              className="h-full w-full object-contain [image-rendering:pixelated]"
                            />
                          ) : (
                            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
                          )}
                        </div>

                        <div className="mt-2 font-mono text-[11px] text-slate-400">
                          <p>{activeObs?.obsDateDisplay}</p>
                          <p>
                            Frame flux:{' '}
                            {displayedInspect?.photometry.netSurfaceBrightness !== null &&
                            displayedInspect?.photometry.netSurfaceBrightness !== undefined
                              ? `${displayedInspect.photometry.netSurfaceBrightness.toFixed(4)} MJy/sr`
                              : 'Loading...'}
                            {inspectA?.photometry.netSurfaceBrightness !== null &&
                              inspectA?.photometry.netSurfaceBrightness !== undefined &&
                              displayedInspect?.photometry.netSurfaceBrightness !== null &&
                              displayedInspect?.photometry.netSurfaceBrightness !== undefined && (
                                <span className="ml-2 text-cyan-300">
                                  (Δ{' '}
                                  {(
                                    displayedInspect.photometry.netSurfaceBrightness -
                                    inspectA.photometry.netSurfaceBrightness
                                  ) >= 0
                                    ? '+'
                                    : ''}
                                  {(
                                    displayedInspect.photometry.netSurfaceBrightness -
                                    inspectA.photometry.netSurfaceBrightness
                                  ).toFixed(4)}
                                  )
                                </span>
                              )}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
                      <div>
                        <label className="block text-[11px] text-slate-400">Base Frame A</label>
                        <select
                          value={obsA?.id || ''}
                          onChange={(e) => setCompareIdA(e.target.value)}
                          className="mt-1 w-full rounded border border-slate-700 bg-[#070B15] px-2 py-1.5 font-mono text-xs text-slate-100"
                        >
                          {filteredObservations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.obsDateDisplay.slice(0, 16)} · {o.bandpassName}
                              {o.emCenterUm ? ` (${o.emCenterUm.toFixed(2)} µm)` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400">Overlay Frame B</label>
                        <select
                          value={obsB?.id || ''}
                          onChange={(e) => setCompareIdB(e.target.value)}
                          className="mt-1 w-full rounded border border-slate-700 bg-[#070B15] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                        >
                          {filteredObservations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.obsDateDisplay.slice(0, 16)} · {o.bandpassName}
                              {o.emCenterUm ? ` (${o.emCenterUm.toFixed(2)} µm)` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1">
                          <label className="block font-mono text-[11px] text-slate-400">
                            Opacity B: {overlayOpacity}%
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={overlayOpacity}
                            onChange={(e) => {
                              setIsBlinking(false);
                              setOverlayOpacity(Number(e.target.value));
                            }}
                            className="w-full accent-cyan-400"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setIsBlinking((b) => !b)}
                          className={`rounded border px-2.5 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
                            isBlinking
                              ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                              : 'border-slate-700 bg-slate-900 text-slate-300'
                          }`}
                        >
                          {isBlinking ? 'Stop Blink' : 'Blink A/B'}
                        </button>
                      </div>
                    </div>

                    <div className="relative flex h-[360px] items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-[#040710]">
                      {inspectA && (
                        <img
                          src={inspectA.pngDataUrl}
                          alt="Overlay base frame A"
                          referrerPolicy="no-referrer"
                          className="absolute h-[330px] w-[330px] object-contain [image-rendering:pixelated]"
                        />
                      )}
                      {inspectB && (
                        <img
                          src={inspectB.pngDataUrl}
                          alt="Overlay frame B"
                          referrerPolicy="no-referrer"
                          className="absolute h-[330px] w-[330px] object-contain [image-rendering:pixelated] transition-opacity duration-150"
                          style={{
                            opacity: isBlinking ? (blinkShowB ? 1 : 0) : overlayOpacity / 100,
                          }}
                        />
                      )}
                      {(!inspectA || !inspectB) && (
                        <>
                          {(obsA && !inspectA && frameErrorMap[renderKey(obsA.id)]) ||
                          (obsB && !inspectB && frameErrorMap[renderKey(obsB.id)]) ? (
                            <div className="relative z-10 flex flex-col items-center gap-2 rounded-lg border border-slate-800 bg-[#050811]/90 px-4 py-3 text-center">
                              <p className="text-xs font-medium text-amber-300">
                                Unable to load overlay frame
                              </p>
                              <button
                                type="button"
                                onClick={() => {
                                  if (obsA && !inspectA) retryFrameInspect(obsA);
                                  if (obsB && !inspectB) retryFrameInspect(obsB);
                                }}
                                className="inline-flex items-center gap-1 rounded bg-cyan-500 px-3 py-1 text-[11px] font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                              >
                                <RefreshCw className="h-3 w-3" />
                                <span>Retry</span>
                              </button>
                            </div>
                          ) : (
                            <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Metadata & Photometry Inspector */}
              <div className="flex flex-col justify-between p-4 sm:p-5 lg:col-span-4">
                <div>
                  <div className="border-b border-slate-800 pb-3">
                    <p className="text-xs font-medium text-cyan-300">Selected Observation</p>
                    <h3 className="mt-1 truncate font-display text-base font-semibold text-white">
                      {activeObs?.obsId || 'Loading...'}
                    </h3>
                    <p className="mt-0.5 font-mono text-xs text-slate-400">
                      {activeObs?.obsDateDisplay}
                    </p>
                  </div>

                  <dl className="mt-4 space-y-3 text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-slate-400">Spectral Band</dt>
                      <dd className="font-mono font-medium text-slate-100">
                        {activeObs?.bandpassName || 'Not available'}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-slate-400">Wavelength Range</dt>
                      <dd className="font-mono tabular-nums text-slate-100">
                        {activeObs?.emMinUm && activeObs?.emMaxUm
                          ? `${activeObs.emMinUm.toFixed(3)} – ${activeObs.emMaxUm.toFixed(3)} µm`
                          : 'Not available'}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-slate-400">Exposure Duration</dt>
                      <dd className="font-mono tabular-nums text-slate-100">
                        {activeObs?.exposureSec
                          ? `${activeObs.exposureSec.toFixed(2)} s`
                          : 'Not available'}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-slate-400">Target Net Brightness</dt>
                      <dd className="font-mono tabular-nums text-cyan-300">
                        {displayedInspect?.photometry.netSurfaceBrightness !== null &&
                        displayedInspect?.photometry.netSurfaceBrightness !== undefined
                          ? `${displayedInspect.photometry.netSurfaceBrightness.toFixed(4)} ± ${
                              displayedInspect.photometry.uncertaintySigma?.toFixed(4) ?? '—'
                            } MJy/sr`
                          : 'Measuring...'}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-slate-400">Quality &amp; Flags</dt>
                      <dd className="font-mono text-slate-100">
                        {displayedInspect?.headers.spsFlags || 'Pending'}
                        {displayedInspect
                          ? ` · ${(displayedInspect.photometry.flaggedPixelFraction * 100).toFixed(1)}% masked`
                          : ''}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-slate-400">Archive Source</dt>
                      <dd className="text-slate-200">
                        {activeObs?.dataSource} ({activeObs?.collection})
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-5 border-t border-slate-800 pt-3">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedMeta((v) => !v)}
                      className="flex w-full items-center justify-between text-xs font-medium text-slate-300 hover:text-cyan-300 cursor-pointer"
                    >
                      <span>Technical FITS &amp; WCS Metadata</span>
                      {showAdvancedMeta ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>

                    {showAdvancedMeta && displayedInspect && (
                      <div className="mt-3 space-y-2 rounded-lg border border-slate-800 bg-[#070B15] p-3 font-mono text-[11px] text-slate-300">
                        <p>MJD-OBS: {displayedInspect.headers.mjdObs?.toFixed(6) ?? 'N/A'}</p>
                        <p>
                          WCS CTYPE: {displayedInspect.headers.ctype1 || 'N/A'} /{' '}
                          {displayedInspect.headers.ctype2 || 'N/A'}
                        </p>
                        <p>
                          CRVAL: {displayedInspect.headers.crval1?.toFixed(5) ?? 'N/A'},{' '}
                          {displayedInspect.headers.crval2?.toFixed(5) ?? 'N/A'}
                        </p>
                        <p>
                          Target Pixel: ({displayedInspect.photometry.targetPixelX ?? '—'},{' '}
                          {displayedInspect.photometry.targetPixelY ?? '—'})
                        </p>
                        <p>MEF HDUs: {displayedInspect.headers.hduNames.join(', ')}</p>
                        <p>
                          Min SAA Dist:{' '}
                          {displayedInspect.headers.minGcd2SaaDeg?.toFixed(1) ?? 'N/A'}°
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {activeObs?.accessUrl && (
                  <div className="mt-4 border-t border-slate-800 pt-3">
                    <a
                      href={
                        activeObs.dataSource.includes('Cube')
                          ? `/api/fits-single-hdu?access_url=${encodeURIComponent(activeObs.accessUrl)}&ra=${searchResult?.query.raDeg ?? activeObs.raDeg}&dec=${searchResult?.query.decDeg ?? activeObs.decDeg}&size=0.14`
                          : activeObs.accessUrl
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
                    >
                      <span>
                        {activeObs.dataSource.includes('Cube')
                          ? 'Download Calibrated FITS Cutout'
                          : 'Download Full MEF FITS (IRSA)'}
                      </span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                )}
              </div>
            </div>

            {/* Chronological Observation Timeline & Preparation-Gated Time-Lapse Player */}
            <div className="rounded-b-xl border border-t-0 border-slate-800 bg-[#0A101E] p-4 sm:p-5">
              {/* Preparation Queue Progress Indicator */}
              {isPreparingQueue && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mb-4 rounded-lg border border-cyan-500/40 bg-cyan-950/25 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
                      <div>
                        <p className="text-xs font-medium text-cyan-100">
                          Preparing astronomical observations... ({prepSummary.ready} of{' '}
                          {prepSummary.total} observations ready)
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                          Ready: {prepSummary.ready} · Remaining: {prepSummary.remaining} ·
                          Unavailable: {prepSummary.failedOrTimeout} (30s timeout per observation)
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={cancelPrepQueue}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Cancel</span>
                    </button>
                  </div>
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-cyan-400 transition-all duration-200"
                      style={{
                        width: `${
                          prepSummary.total > 0
                            ? Math.round(
                                ((prepSummary.ready + prepSummary.failedOrTimeout) /
                                  prepSummary.total) *
                                  100
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Post-Preparation Partial Availability Notice + Expandable Failed List */}
              {prepCompleted && unavailableRecords.length > 0 && (
                <div className="mb-4 rounded-lg border border-amber-500/35 bg-amber-950/20 p-3.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-amber-200">
                      <Info className="h-4 w-4 shrink-0 text-amber-300" />
                      <span>
                        {readyObservations.length} of {filteredObservations.length} observations are
                        available. Unavailable observations will be skipped during playback.
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={retryFailedQueueObservations}
                        className="inline-flex items-center gap-1 rounded border border-cyan-500/50 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/20 cursor-pointer whitespace-nowrap"
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>Retry Failed</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowFailedDetails((v) => !v)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 hover:text-amber-200 cursor-pointer"
                      >
                        <span>
                          {showFailedDetails ? 'Hide' : 'View'} skipped ({unavailableRecords.length})
                        </span>
                        {showFailedDetails ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {showFailedDetails && (
                    <ul className="mt-3 max-h-40 space-y-1.5 overflow-y-auto border-t border-amber-500/20 pt-2.5 font-mono text-[11px] text-slate-300">
                      {unavailableRecords.map((rec) => (
                        <li key={rec.id} className="flex flex-wrap justify-between gap-2">
                          <span>
                            {rec.dateDisplay.slice(0, 19)} · {rec.obsId} ({rec.status})
                          </span>
                          <span className="text-amber-300/90">{rec.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Zero or < 2 Ready Warning after Preparation */}
              {prepCompleted && readyObservations.length === 0 && (
                <div
                  role="alert"
                  className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-500/40 bg-rose-950/30 p-3.5 text-xs text-rose-200"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    <div>
                      <p className="font-medium">No Observations Could Be Prepared</p>
                      <p className="mt-0.5 text-rose-200/90">
                        All {filteredObservations.length} observations in this sequence failed or timed
                        out while retrieving data from IRSA. Please try another target, detector band,
                        or retry shortly.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={retryFailedQueueObservations}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Retry All</span>
                  </button>
                </div>
              )}

              {prepCompleted && readyObservations.length === 1 && (
                <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-300">
                  Time-lapse playback requires at least 2 prepared observations. Only 1 observation
                  was successfully prepared for this sequence.
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-4">
                {/* Playback Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={filteredObservations.length <= 1 || isPreparingQueue}
                    onClick={() => handleStep(-1)}
                    aria-label="Previous observation"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                  >
                    <SkipBack className="h-4 w-4" />
                  </button>

                  <button
                    type="button"
                    disabled={
                      filteredObservations.length <= 1 ||
                      (prepCompleted && readyObservations.length < 2)
                    }
                    onClick={handleToggleTimelapse}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-cyan-500 px-4 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {isPreparingQueue ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Preparing ({prepSummary.ready}/{prepSummary.total})...</span>
                      </>
                    ) : isPlaying ? (
                      <>
                        <Pause className="h-4 w-4" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4" />
                        <span>
                          {prepSummary.remaining === 0 && readyObservations.length >= 2
                            ? `Play Time-Lapse (${readyObservations.length} ready)`
                            : `Prepare & Play Time-Lapse (${filteredObservations.length})`}
                        </span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={filteredObservations.length <= 1 || isPreparingQueue}
                    onClick={() => handleStep(1)}
                    aria-label="Next observation"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                  >
                    <SkipForward className="h-4 w-4" />
                  </button>

                  <select
                    aria-label="Time-lapse playback speed"
                    value={playbackMs}
                    onChange={(e) => setPlaybackMs(Number(e.target.value))}
                    className="ml-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-200"
                  >
                    <option value={1500}>0.5×</option>
                    <option value={950}>1.0×</option>
                    <option value={500}>2.0×</option>
                  </select>
                </div>

                {/* Observation Counter, Readiness & Date */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-slate-300 tabular-nums">
                  {prepCompleted && readyObservations.length > 0 ? (
                    <span>
                      Playing{' '}
                      <span className="font-semibold text-cyan-300">
                        {activeReadyIndex >= 0 ? activeReadyIndex + 1 : 1}
                      </span>{' '}
                      of {readyObservations.length} ready
                    </span>
                  ) : (
                    <span>
                      Observation{' '}
                      <span className="font-semibold text-cyan-300">
                        {activeObs
                          ? filteredObservations.findIndex((o) => o.id === activeObs.id) + 1
                          : 0}
                      </span>{' '}
                      of {filteredObservations.length}
                    </span>
                  )}
                  <span aria-hidden="true" className="text-slate-600">
                    ·
                  </span>
                  <span className="text-slate-400">
                    Ready {prepSummary.ready}/{prepSummary.total}
                  </span>
                  {activeObs && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span>{activeObs.obsDateDisplay}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Scrubber */}
              {(prepCompleted && readyObservations.length > 1
                ? readyObservations.length
                : filteredObservations.length) > 1 && (
                <div className="mt-4">
                  <input
                    type="range"
                    aria-label="Timeline observation scrubber"
                    min={0}
                    max={
                      (prepCompleted && readyObservations.length > 1
                        ? readyObservations.length
                        : filteredObservations.length) - 1
                    }
                    value={
                      prepCompleted && readyObservations.length > 1
                        ? Math.max(0, activeReadyIndex)
                        : Math.max(
                            0,
                            filteredObservations.findIndex((o) => o.id === activeObs?.id)
                          )
                    }
                    onChange={(e) => {
                      clearPlaybackTimer();
                      setIsPlaying(false);
                      const idx = Number(e.target.value);
                      const list =
                        prepCompleted && readyObservations.length > 1
                          ? readyObservations
                          : filteredObservations;
                      if (list[idx]) setSelectedObsId(list[idx].id);
                    }}
                    className="w-full accent-cyan-400 cursor-pointer"
                  />
                </div>
              )}

              {/* Scrollable Chronological Epoch Strip */}
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {filteredObservations.map((obs) => {
                  const isSelected = activeObs?.id === obs.id;
                  const rec = prepMap[obs.id];
                  const isCached = Boolean(fitsCache[renderKey(obs.id)]?.pngDataUrl);
                  const statusLabel =
                    rec?.status === 'failed'
                      ? 'failed (skipped)'
                      : rec?.status === 'timed-out'
                        ? 'timed out (skipped)'
                        : rec?.status === 'loading'
                          ? 'loading...'
                          : rec?.status === 'processing'
                            ? 'processing...'
                            : isCached
                              ? 'ready'
                              : 'pending';
                  const isUnavailable =
                    rec?.status === 'failed' || rec?.status === 'timed-out';

                  return (
                    <button
                      key={obs.id}
                      type="button"
                      disabled={isUnavailable && isPlaying}
                      onClick={() => {
                        clearPlaybackTimer();
                        setIsPlaying(false);
                        setSelectedObsId(obs.id);
                      }}
                      className={`shrink-0 rounded-lg border px-3 py-1.5 text-left transition-colors cursor-pointer disabled:opacity-45 ${
                        isSelected
                          ? 'border-cyan-400 bg-slate-800 text-white'
                          : isUnavailable
                            ? 'border-amber-800/60 bg-[#120D10] text-slate-400'
                            : isCached
                              ? 'border-slate-700 bg-[#091020] text-slate-200 hover:border-slate-600'
                              : 'border-slate-800 bg-[#070B15] text-slate-400 hover:border-slate-700 hover:text-slate-200'
                      }`}
                    >
                      <p className="font-mono tabular-nums text-[11px] font-medium">
                        {obs.spectralChannel !== undefined && obs.emCenterUm
                          ? `${obs.emCenterUm.toFixed(2)} µm · Ch ${obs.spectralChannel}`
                          : obs.obsDateDisplay.slice(0, 10)}
                      </p>
                      <p
                        className={`font-mono text-[10px] ${
                          isUnavailable ? 'text-amber-400' : 'text-cyan-300/80'
                        }`}
                      >
                        {obs.bandpassName} · {statusLabel}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            <ScientificCharts
              observations={filteredObservations}
              activeObs={activeObs}
              measuredMap={photometryMap}
              isSampling={isSampling}
              onSampleTimeline={handleSampleTimeline}
              onSelectObservation={(obsId) => {
                clearPlaybackTimer();
                setIsPlaying(false);
                setSelectedObsId(obsId);
              }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
