import { useEffect, useState } from 'react';
import { X, ArrowRight, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import type { FeaturedObservation } from '../types/spherex.ts';
import fallbackSkyUrl from '../assets/images/demo_infrared_sky_fallback_1794658521882.jpg';
import { SiGeneratedWatermark } from './SiGeneratedWatermark.tsx';

interface FeaturedGalleryModalProps {
  open: boolean;
  items: FeaturedObservation[];
  featuredIndex: number;
  featuredLoading?: boolean;
  featuredError?: string | null;
  dateKey: string;
  matchedLocalDate?: boolean;
  onClose: () => void;
  onSelectInExplorer: (item: FeaturedObservation) => void;
  onRetryFeatured?: () => void;
}

export function FeaturedGalleryModal({
  open,
  items,
  featuredIndex,
  featuredLoading = false,
  featuredError = null,
  dateKey,
  matchedLocalDate = false,
  onClose,
  onSelectInExplorer,
  onRetryFeatured,
}: FeaturedGalleryModalProps) {
  const [selectedIdx, setSelectedIdx] = useState(featuredIndex);

  useEffect(() => {
    if (open) {
      setSelectedIdx(featuredIndex);
    }
  }, [open, featuredIndex]);

  if (!open) return null;

  if (items.length === 0) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="SPHEREx Featured Observations Archive"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      >
        <div className="w-full max-w-md rounded-xl border border-slate-700/80 bg-[#0A101E] p-6 text-center">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close gallery"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800 text-slate-300 hover:bg-slate-900 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {featuredLoading ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
              <p className="text-sm text-slate-300">
                Fetching featured SPHEREx observations...
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <AlertCircle className="h-8 w-8 text-rose-400" />
              <h2 className="font-display text-lg font-semibold text-white">
                Featured Observations Unavailable
              </h2>
              <p className="text-xs leading-relaxed text-slate-400">
                {featuredError || 'Could not retrieve featured observations from NASA/IPAC IRSA.'}
              </p>
              {onRetryFeatured && (
                <button
                  type="button"
                  onClick={onRetryFeatured}
                  className="mt-2 inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Retry</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const activeItem = items[selectedIdx] || items[0];
  const obs = activeItem.observation;
  const headers = activeItem.headers;
  const isActiveFallback = activeItem.isDemonstrationFallback || !activeItem.previewImageUrl;
  const imgSrc = !isActiveFallback ? activeItem.previewImageUrl! : fallbackSkyUrl;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="SPHEREx Featured Observations Archive"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700/80 bg-[#0A101E]">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-6 py-4">
          <div>
            <p className="text-xs font-medium text-cyan-300">
              {matchedLocalDate
                ? `Today's Local Archive Match · ${dateKey}`
                : `Latest Available Observations · Local Date ${dateKey}`}
            </p>
            <h2 className="font-display text-lg font-semibold text-white">
              SPHEREx Featured Sky Observations
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {activeItem.isDemonstrationFallback && onRetryFeatured && (
              <button
                type="button"
                disabled={featuredLoading}
                onClick={onRetryFeatured}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${featuredLoading ? 'animate-spin' : ''}`} />
                <span>Retry Live Data</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close gallery"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-800 text-slate-300 hover:bg-slate-900 hover:text-white cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Main Content */}
        <div className="grid flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-12">
          {/* Selected Image & Metadata */}
          <div className="flex flex-col border-b border-slate-800 p-6 lg:col-span-8 lg:border-r lg:border-b-0">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-slate-800 bg-[#050811]">
              <img
                src={imgSrc}
                alt={`SPHEREx observation of ${activeItem.title}`}
                referrerPolicy="no-referrer"
                className="h-full w-full object-contain"
              />
              {selectedIdx === featuredIndex && !activeItem.isDemonstrationFallback && (
                <span className="absolute left-3 top-3 rounded bg-slate-950/85 px-2.5 py-1 text-xs font-medium text-cyan-300">
                  {matchedLocalDate ? "Today's Featured Capture" : 'Latest Available Capture'}
                </span>
              )}
              {isActiveFallback && <SiGeneratedWatermark />}
            </div>

            <div className="mt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-xl font-semibold text-white">
                  {activeItem.title}
                </h3>
                <span className="font-mono text-xs text-slate-400">
                  {obs.bandpassName}
                  {obs.emMinUm && obs.emMaxUm
                    ? ` · ${obs.emMinUm.toFixed(2)}–${obs.emMaxUm.toFixed(2)} µm`
                    : ''}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                {activeItem.scientificContext}
              </p>

              <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-800/80 pt-4 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-slate-400">Observation Date</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                    {headers?.dateObs || obs.obsDateDisplay}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">ICRS Coordinates</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                    {obs.raHms}, {obs.decDms}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Observation ID</dt>
                  <dd className="mt-0.5 truncate font-mono text-slate-100" title={obs.obsId}>
                    {obs.obsId}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Exposure Time</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                    {obs.exposureSec ? `${obs.exposureSec.toFixed(2)} s` : 'Not available'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Survey Quality</dt>
                  <dd className="mt-0.5 font-mono text-slate-100">
                    {headers?.spsFlags || 'Not available'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Archive Collection</dt>
                  <dd className="mt-0.5 font-mono text-slate-100">{obs.collection}</dd>
                </div>
              </dl>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                {!activeItem.isDemonstrationFallback && (
                  <button
                    type="button"
                    onClick={() => {
                      onSelectInExplorer(activeItem);
                      onClose();
                    }}
                    className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
                  >
                    <span>Inspect Region in Sky Explorer</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                )}
                {obs.accessUrl && (
                  <a
                    href={
                      obs.dataSource.includes('Cube')
                        ? `/api/fits-single-hdu?access_url=${encodeURIComponent(obs.accessUrl)}&ra=${obs.raDeg}&dec=${obs.decDeg}&size=0.14`
                        : obs.accessUrl
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
                  >
                    <span>
                      {obs.dataSource.includes('Cube')
                        ? 'Download Calibrated FITS Cutout'
                        : 'Download Source MEF FITS'}
                    </span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Archive Thumbnail List */}
          <div className="flex flex-col gap-2 bg-[#080D19] p-4 lg:col-span-4">
            <p className="px-2 pb-2 text-xs font-medium text-slate-400">
              Available Archive Selections ({items.length})
            </p>
            {items.map((item, idx) => {
              const isSelected = idx === selectedIdx;
              const isThumbFallback = item.isDemonstrationFallback || !item.previewImageUrl;
              const thumb = !isThumbFallback ? item.previewImageUrl! : fallbackSkyUrl;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedIdx(idx)}
                  className={`flex items-center gap-3 rounded-lg border p-2.5 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-cyan-400/70 bg-slate-900'
                      : 'border-slate-800/80 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/80'
                  }`}
                >
                  <div className="relative h-16 w-20 shrink-0 overflow-hidden rounded border border-slate-800">
                    <img
                      src={thumb}
                      alt={item.title}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                    {isThumbFallback && <SiGeneratedWatermark variant="compact" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-100">{item.title}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                      {item.observation.obsDateDisplay.slice(0, 10)} ·{' '}
                      {item.observation.bandpassName}
                    </p>
                    {idx === featuredIndex && !item.isDemonstrationFallback && (
                      <p className="mt-1 text-[11px] font-medium text-cyan-300">
                        {matchedLocalDate ? 'Captured Today (Local)' : 'Latest Available'}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
