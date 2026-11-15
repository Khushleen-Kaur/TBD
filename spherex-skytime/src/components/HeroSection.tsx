import { useState } from 'react';
import { ArrowDown, ArrowRight, RotateCw, RefreshCw, Images, ExternalLink, AlertCircle } from 'lucide-react';
import type { FeaturedObservation } from '../types/spherex.ts';
import fallbackSkyUrl from '../assets/images/demo_infrared_sky_fallback_1794658521882.jpg';
import { SiGeneratedWatermark } from './SiGeneratedWatermark.tsx';

interface HeroSectionProps {
  featured: FeaturedObservation | null;
  featuredLoading: boolean;
  featuredError?: string | null;
  matchedLocalDate?: boolean;
  localDate?: string;
  onStartExploring: () => void;
  onDiscoverMission: () => void;
  onOpenGallery: () => void;
  onLoadFeaturedInExplorer: (item: FeaturedObservation) => void;
  onRetryFeatured?: () => void;
}

const STAR_POINTS = [
  { x: 8, y: 14, s: 1.5, o: 0.55 },
  { x: 16, y: 42, s: 1, o: 0.35 },
  { x: 24, y: 21, s: 2, o: 0.6 },
  { x: 33, y: 68, s: 1.2, o: 0.4 },
  { x: 41, y: 12, s: 1.5, o: 0.45 },
  { x: 48, y: 31, s: 1, o: 0.3 },
  { x: 56, y: 84, s: 1.6, o: 0.45 },
  { x: 64, y: 18, s: 1.2, o: 0.4 },
  { x: 72, y: 53, s: 1.8, o: 0.55 },
  { x: 82, y: 26, s: 1, o: 0.35 },
  { x: 89, y: 74, s: 1.5, o: 0.5 },
  { x: 94, y: 15, s: 2, o: 0.65 },
  { x: 12, y: 82, s: 1.3, o: 0.4 },
  { x: 28, y: 89, s: 1, o: 0.3 },
  { x: 61, y: 44, s: 1.2, o: 0.35 },
  { x: 78, y: 90, s: 1.4, o: 0.4 },
];

// Subtle shooting stars traveling top-left -> bottom-right
const SHOOTING_STARS = [
  { left: '6%', top: '8%', width: 'w-24', duration: '9s', delay: '1.2s' },
  { left: '24%', top: '5%', width: 'w-20', duration: '12s', delay: '4.5s' },
  { left: '46%', top: '12%', width: 'w-28', duration: '14s', delay: '7.8s' },
  { left: '14%', top: '34%', width: 'w-20', duration: '16s', delay: '10.4s' },
  { left: '64%', top: '7%', width: 'w-24', duration: '13s', delay: '2.9s' },
  { left: '36%', top: '26%', width: 'w-16', duration: '18s', delay: '13.2s' },
];

export function HeroSection({
  featured,
  featuredLoading,
  featuredError = null,
  matchedLocalDate = false,
  localDate = '',
  onStartExploring,
  onDiscoverMission,
  onOpenGallery,
  onLoadFeaturedInExplorer,
  onRetryFeatured,
}: HeroSectionProps) {
  const [isFlipped, setIsFlipped] = useState(false);

  const hasFailedLoad = !featuredLoading && (Boolean(featuredError) || !featured);
  const canRetryLive = !featuredLoading && (hasFailedLoad || Boolean(featured?.isDemonstrationFallback));

  const isUsingFallbackImage = !(
    featured &&
    !featured.isDemonstrationFallback &&
    featured.previewImageUrl
  );

  const imageSrc = !isUsingFallbackImage ? featured.previewImageUrl! : fallbackSkyUrl;

  const obs = featured?.observation;
  const headers = featured?.headers;

  return (
    <section
      id="home"
      className="relative overflow-hidden border-b border-slate-800/80 bg-[#060A14]"
    >
      {/* Subtle deep-space background gradient & restrained starfield */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_25%,rgba(29,78,216,0.16),transparent_55%),radial-gradient(ellipse_at_80%_20%,rgba(6,182,212,0.10),transparent_50%)]"
      />
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
      >
        {STAR_POINTS.map((st, idx) => (
          <circle
            key={idx}
            cx={`${st.x}%`}
            cy={`${st.y}%`}
            r={st.s}
            fill="#E2E8F0"
            opacity={st.o}
          />
        ))}
      </svg>

      {/* Subtle shooting stars traveling top-left to bottom-right (disabled under prefers-reduced-motion) */}
      {SHOOTING_STARS.map((star, idx) => (
        <div
          key={idx}
          aria-hidden="true"
          style={{
            left: star.left,
            top: star.top,
            animationDuration: star.duration,
            animationDelay: star.delay,
          }}
          className={`pointer-events-none absolute h-px ${star.width} origin-left bg-gradient-to-r from-transparent via-cyan-300/35 to-cyan-100/90 animate-shooting-star`}
        />
      ))}

      <div className="relative mx-auto grid max-w-[1280px] grid-cols-1 items-stretch gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-12 lg:gap-12 lg:px-8 lg:py-24">
        {/* Left column: Main Introduction */}
        <div className="flex flex-col justify-center lg:col-span-6">
          <p className="mb-4 text-xs font-medium tracking-wider text-cyan-300/90">
            NASA Space Apps Challenge 2026 · Planet X &amp; SPHEREx
          </p>

          <h1 className="font-display text-4xl font-bold tracking-tight text-slate-50 sm:text-5xl lg:text-[3.5rem] lg:leading-[1.08] [text-wrap:balance]">
            Explore the Universe Through Time.
          </h1>

          <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-300 sm:text-lg">
            Discover how the sky changes across time and wavelengths through real observations from
            NASA&apos;s SPHEREx mission. Enter any coordinates, step through real near-infrared
            snapshots chronologically, and compare how stars and brown dwarfs shift or vary.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onStartExploring}
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
            >
              <span>Start Exploring</span>
              <ArrowDown className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={onDiscoverMission}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/70 px-6 py-3 text-sm font-semibold text-slate-100 transition-colors hover:border-slate-600 hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
            >
              <span>Discover SPHEREx</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          {/* Unboxed quiet provenance summary */}
          <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-800/80 pt-6 text-xs text-slate-400">
            <span>102 Spectral Bands (0.75–5.0 µm)</span>
            <span aria-hidden="true">·</span>
            <span>NASA/IPAC IRSA DR1 Archive</span>
            <span aria-hidden="true">·</span>
            <span>Live Multi-Extension FITS Cutouts</span>
          </div>
        </div>

        {/* Right column: Picture of the Day Flip Card */}
        <div className="flex flex-col justify-center lg:col-span-6">
          <div className="perspective-1200 w-full">
            <div
              className={`preserve-3d relative min-h-[430px] w-full transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] sm:min-h-[470px] ${
                isFlipped ? 'rotate-y-180' : ''
              }`}
            >
              {/* FRONT OF CARD */}
              <div className="backface-hidden absolute inset-0 flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#0B1222]">
                <div className="relative flex-1 overflow-hidden bg-[#050811]">
                  {featuredLoading ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
                      <p className="text-sm text-slate-400">
                        Retrieving featured SPHEREx observation from NASA/IPAC IRSA...
                      </p>
                    </div>
                  ) : hasFailedLoad && !featured ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                      <AlertCircle className="h-7 w-7 text-rose-400" />
                      <div>
                        <p className="text-sm font-medium text-rose-200">
                          Featured Data API Unavailable
                        </p>
                        <p className="mt-1 max-w-sm text-xs text-slate-400">
                          {featuredError ||
                            'Unable to retrieve the live featured SPHEREx observation.'}
                        </p>
                      </div>
                      {onRetryFeatured && (
                        <button
                          type="button"
                          onClick={onRetryFeatured}
                          className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          <span>Retry</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      <img
                        src={imageSrc}
                        alt={
                          featured
                            ? `SPHEREx near-infrared observation of ${featured.title}`
                            : 'Near-infrared sky observation'
                        }
                        referrerPolicy="no-referrer"
                        onClick={() => setIsFlipped(true)}
                        className="h-full w-full cursor-pointer object-cover transition-transform duration-300 hover:scale-[1.02]"
                      />
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#060A14] via-[#060A14]/35 to-transparent"
                      />
                      {isUsingFallbackImage && <SiGeneratedWatermark />}
                    </>
                  )}

                  {/* Top overlay controls */}
                  <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent px-5 py-4">
                    <span className="text-xs font-medium tracking-wide text-cyan-300">
                      {featuredLoading
                        ? 'SPHEREx · Connecting to Archive'
                        : featuredError
                          ? 'Archive Request Failed'
                          : featured?.isDemonstrationFallback
                            ? 'Demonstration Fallback Plate'
                            : matchedLocalDate
                              ? `SPHEREx · Featured Today (${localDate})`
                              : 'SPHEREx · Latest Available Observation'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsFlipped(true)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700/80 bg-slate-950/75 px-3 py-1.5 text-xs font-medium text-slate-200 backdrop-blur-sm transition-colors hover:border-cyan-400/60 hover:text-white cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      <span>View metadata</span>
                    </button>
                  </div>

                  {/* Bottom overlay caption */}
                  {!(hasFailedLoad && !featured) && (
                    <div
                      className={`absolute inset-x-0 bottom-0 px-5 pb-5 pt-10 ${
                        isUsingFallbackImage ? 'pr-28 sm:pr-32' : ''
                      }`}
                    >
                      <h2 className="font-display text-xl font-semibold text-white sm:text-2xl">
                        {featured ? featured.title : 'WISE 0855'}
                      </h2>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-300">
                        <span className="font-mono tabular-nums">
                          {featuredLoading
                            ? 'Loading observation date...'
                            : obs?.obsDateDisplay || 'Observation date unavailable'}
                        </span>
                        {obs?.bandpassName && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">
                              {obs.bandpassName}
                              {obs.emMinUm && obs.emMaxUm
                                ? ` (${obs.emMinUm.toFixed(2)}–${obs.emMaxUm.toFixed(2)} µm)`
                                : ''}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Card footer actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/90 bg-[#0B1222] px-5 py-3.5">
                  <button
                    type="button"
                    onClick={onOpenGallery}
                    className="inline-flex items-center gap-2 text-sm font-medium text-cyan-300 transition-colors hover:text-cyan-200 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Images className="h-4 w-4" />
                    <span>Explore Featured Archive</span>
                  </button>

                  <div className="flex items-center gap-2">
                    {canRetryLive && onRetryFeatured && (
                      <button
                        type="button"
                        onClick={onRetryFeatured}
                        className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Retry Live Data</span>
                      </button>
                    )}

                    {featured && !featured.isDemonstrationFallback && (
                      <button
                        type="button"
                        onClick={() => onLoadFeaturedInExplorer(featured)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <span>Explore Image</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* BACK OF CARD (Real Metadata) */}
              <div className="backface-hidden rotate-y-180 absolute inset-0 flex flex-col justify-between overflow-hidden rounded-xl border border-slate-700/80 bg-[#0C1426] p-5 sm:p-6">
                <div>
                  <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
                    <div>
                      <p className="text-xs font-medium text-cyan-300">
                        {featured?.isDemonstrationFallback
                          ? 'Demonstration Fallback Metadata'
                          : 'SPHEREx Observation Metadata'}
                      </p>
                      <h3 className="mt-1 font-display text-lg font-semibold text-white">
                        {featured?.title || 'Observation Details'}
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsFlipped(false)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-400/60 hover:text-white cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      <span>Flip to image</span>
                    </button>
                  </div>

                  <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-slate-400">Right Ascension (RA)</dt>
                      <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                        {obs ? `${obs.raHms} (${obs.raDeg.toFixed(5)}°)` : 'Not available'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-400">Declination (Dec)</dt>
                      <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                        {obs ? `${obs.decDms} (${obs.decDeg.toFixed(5)}°)` : 'Not available'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-400">Observation Date &amp; Time</dt>
                      <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                        {headers?.dateObs || obs?.obsDateDisplay || 'Not available'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-400">Observation ID</dt>
                      <dd className="mt-0.5 truncate font-mono text-slate-100" title={obs?.obsId}>
                        {obs?.obsId || 'Not available'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-400">Spectral Band &amp; Wavelength</dt>
                      <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                        {obs?.bandpassName || 'Not available'}
                        {obs?.emMinUm && obs?.emMaxUm
                          ? ` · ${obs.emMinUm.toFixed(2)}–${obs.emMaxUm.toFixed(2)} µm`
                          : ''}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-400">Detector / Exposure</dt>
                      <dd className="mt-0.5 font-mono tabular-nums text-slate-100">
                        {headers?.detector ? `Detector ${headers.detector}` : 'Not available'}
                        {obs?.exposureSec ? ` · ${obs.exposureSec.toFixed(1)} s` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-400">Data Quality / Flags</dt>
                      <dd className="mt-0.5 font-mono text-slate-100">
                        {headers?.spsFlags
                          ? `${headers.spsFlags}${
                              featured?.photometry
                                ? ` · ${(featured.photometry.flaggedPixelFraction * 100).toFixed(1)}% masked px`
                                : ''
                            }`
                          : 'Not available'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-400">Archive Reference</dt>
                      <dd className="mt-0.5 text-slate-100">
                        {featured?.isDemonstrationFallback
                          ? 'Demonstration Fallback'
                          : `${obs?.dataSource || 'NASA/IPAC IRSA'} (${obs?.collection || 'spherex_dr1'})`}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
                  <button
                    type="button"
                    onClick={onOpenGallery}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-300 hover:text-cyan-200 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Images className="h-3.5 w-3.5" />
                    <span>Open Full Details &amp; Gallery</span>
                  </button>

                  {featured && !featured.isDemonstrationFallback && (
                    <button
                      type="button"
                      onClick={() => onLoadFeaturedInExplorer(featured)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <span>Load in Sky Explorer</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
