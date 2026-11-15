import { useState } from 'react';
import { Loader2, Activity } from 'lucide-react';
import type { FitsInspectResponse, SpherexObservation } from '../types/spherex.ts';

export interface MeasuredPoint {
  obs: SpherexObservation;
  inspect: FitsInspectResponse;
}

interface ScientificChartsProps {
  observations: SpherexObservation[];
  activeObs: SpherexObservation | null;
  measuredMap: Record<string, FitsInspectResponse>;
  isSampling: boolean;
  onSampleTimeline: () => void;
  onSelectObservation: (obsId: string) => void;
}

const SPHEREX_BANDS = [
  { id: 'SPHEREx-D1', short: 'D1', min: 0.75, max: 1.11, color: '#38BDF8', science: 'Stellar continuum & near-IR absorption' },
  { id: 'SPHEREx-D2', short: 'D2', min: 1.11, max: 1.64, color: '#22D3EE', science: 'H₂O & CH₄ features in brown dwarfs' },
  { id: 'SPHEREx-D3', short: 'D3', min: 1.63, max: 2.43, color: '#818CF8', science: 'Cool photospheres & dust scattering' },
  { id: 'SPHEREx-D4', short: 'D4', min: 2.42, max: 3.82, color: '#A78BFA', science: 'H₂O ice (3.0 µm) & PAH emission' },
  { id: 'SPHEREx-D5', short: 'D5', min: 3.82, max: 4.42, color: '#FBBF24', science: 'CO₂ ice (4.27 µm) & thermal emission' },
  { id: 'SPHEREx-D6', short: 'D6', min: 4.42, max: 5.00, color: '#F97316', science: 'CO ice (4.67 µm) & ultra-cool objects' },
];

const BAND_COLORS: Record<string, string> = {
  'SPHEREx-D1': '#38BDF8',
  'SPHEREx-D2': '#22D3EE',
  'SPHEREx-D3': '#818CF8',
  'SPHEREx-D4': '#A78BFA',
  'SPHEREx-D5': '#FBBF24',
  'SPHEREx-D6': '#F97316',
};

export function ScientificCharts({
  observations,
  activeObs,
  measuredMap,
  isSampling,
  onSampleTimeline,
  onSelectObservation,
}: ScientificChartsProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const clipId = 'spherex-photometry-plot-clip';

  const measuredPoints: MeasuredPoint[] = observations
    .filter((obs) => measuredMap[obs.id])
    .map((obs) => ({ obs, inspect: measuredMap[obs.id] }))
    .filter((p) => {
      const val = p.inspect.photometry.netSurfaceBrightness;
      return (
        val !== null &&
        Number.isFinite(val) &&
        Number.isFinite(p.obs.tMinMjd)
      );
    })
    .sort((a, b) => {
      const dt = a.obs.tMinMjd - b.obs.tMinMjd;
      if (Math.abs(dt) > 1e-9) return dt;
      return (a.obs.emCenterUm ?? 0) - (b.obs.emCenterUm ?? 0);
    });

  // Build band-level real averages from measured points
  const bandMeasurements = SPHEREX_BANDS.map((band) => {
    const matches = measuredPoints.filter((p) => p.obs.bandpassName === band.id);
    if (matches.length === 0) return { ...band, meanFlux: null, count: 0 };
    const meanFlux =
      matches.reduce((sum, m) => sum + (m.inspect.photometry.netSurfaceBrightness ?? 0), 0) /
      matches.length;
    return { ...band, meanFlux, count: matches.length };
  });

  const maxBandFlux = Math.max(
    0.01,
    ...bandMeasurements.map((b) => Math.abs(b.meanFlux ?? 0))
  );

  // Time-series / SED SVG layout
  const svgW = 640;
  const svgH = 210;
  const padL = 62;
  const padR = 20;
  const padT = 18;
  const padB = 34;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const minMjd = measuredPoints.length
    ? Math.min(...measuredPoints.map((p) => p.obs.tMinMjd))
    : 0;
  const maxMjd = measuredPoints.length
    ? Math.max(...measuredPoints.map((p) => p.obs.tMinMjd))
    : 1;
  const isSingleEpoch = measuredPoints.length > 1 && maxMjd - minMjd <= 1e-9;

  const wavelengths = measuredPoints
    .map((p) => p.obs.emCenterUm)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const minLam = wavelengths.length ? Math.min(...wavelengths) : 0.75;
  const maxLam = wavelengths.length ? Math.max(...wavelengths) : 5.0;
  const useWavelengthAxis = isSingleEpoch && maxLam - minLam > 1e-4;

  const sortedPlotPoints = useWavelengthAxis
    ? [...measuredPoints].sort((a, b) => (a.obs.emCenterUm ?? 0) - (b.obs.emCenterUm ?? 0))
    : measuredPoints;

  const mjdSpan = Math.max(1e-6, maxMjd - minMjd);
  const lamSpan = Math.max(1e-4, maxLam - minLam);

  // Include both flux values AND finite 1-sigma error bounds in Y domain
  const lowBounds: number[] = [];
  const highBounds: number[] = [];
  for (const p of sortedPlotPoints) {
    const val = p.inspect.photometry.netSurfaceBrightness ?? 0;
    const rawSig = p.inspect.photometry.uncertaintySigma ?? 0;
    const sig = Number.isFinite(rawSig) && rawSig > 0 ? rawSig : 0;
    lowBounds.push(val - sig);
    highBounds.push(val + sig);
  }
  const minFlux = lowBounds.length ? Math.min(...lowBounds) : 0;
  const maxFlux = highBounds.length ? Math.max(...highBounds) : 1;
  const fluxPad = Math.max(0.02, (maxFlux - minFlux) * 0.18);
  const yMin = minFlux - fluxPad;
  const yMax = maxFlux + fluxPad;
  const ySpan = Math.max(1e-4, yMax - yMin);

  const clampX = (x: number) =>
    Number.isFinite(x) ? Math.min(padL + plotW, Math.max(padL, x)) : padL;
  const clampY = (y: number) =>
    Number.isFinite(y) ? Math.min(padT + plotH, Math.max(padT, y)) : padT + plotH / 2;

  const toX = (point: MeasuredPoint) => {
    if (sortedPlotPoints.length <= 1) return padL + plotW / 2;
    if (useWavelengthAxis) {
      const lam = point.obs.emCenterUm ?? minLam;
      return clampX(padL + ((lam - minLam) / lamSpan) * plotW);
    }
    if (maxMjd - minMjd <= 1e-9) return padL + plotW / 2;
    return clampX(padL + ((point.obs.tMinMjd - minMjd) / mjdSpan) * plotW);
  };

  const toY = (val: number) => clampY(padT + plotH - ((val - yMin) / ySpan) * plotH);

  const formatTick = (val: number) => {
    const abs = Math.abs(val);
    if (abs >= 100) return val.toFixed(0);
    if (abs >= 10) return val.toFixed(1);
    return val.toFixed(2);
  };

  const hoveredPoint = sortedPlotPoints.find((p) => p.obs.id === hoveredId) || null;

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Brightness Over Time / Wavelength Card */}
      <div className="flex flex-col justify-between rounded-xl border border-slate-800/90 bg-[#0B1222] p-5 lg:col-span-7">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-100">
                {useWavelengthAxis
                  ? 'Measured Surface Brightness Spectrum (SED)'
                  : 'Measured Surface Brightness Over Time'}
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">
                Calibrated aperture flux (MJy/sr, Zodiacal model subtracted) extracted directly from inspected SPHEREx cutouts.
              </p>
            </div>
            <button
              type="button"
              disabled={isSampling || observations.length === 0}
              onClick={onSampleTimeline}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-cyan-300 transition-colors hover:border-cyan-500/50 hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              {isSampling ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Sampling Cutouts...</span>
                </>
              ) : (
                <>
                  <Activity className="h-3.5 w-3.5" />
                  <span>{useWavelengthAxis ? 'Sample Spectral Bands' : 'Sample Timeline Epochs'}</span>
                </>
              )}
            </button>
          </div>

          <div className="relative mt-4 overflow-hidden rounded-lg">
            {sortedPlotPoints.length === 0 ? (
              <div className="flex h-[210px] items-center justify-center rounded-lg border border-dashed border-slate-800 bg-[#070B15] px-4 text-center text-xs text-slate-400">
                Inspect observations or click &ldquo;Sample Timeline Epochs&rdquo; to plot real cutout photometry.
              </div>
            ) : (
              <svg
                viewBox={`0 0 ${svgW} ${svgH}`}
                className="block h-[210px] w-full overflow-hidden"
                role="img"
                aria-label={
                  useWavelengthAxis
                    ? 'Measured surface brightness spectrum across wavelength'
                    : 'Measured surface brightness over time'
                }
              >
                <defs>
                  <clipPath id={clipId}>
                    <rect x={padL - 8} y={padT - 8} width={plotW + 16} height={plotH + 16} />
                  </clipPath>
                </defs>

                {/* Horizontal gridlines */}
                {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                  const y = padT + t * plotH;
                  const val = yMax - t * ySpan;
                  return (
                    <g key={t}>
                      <line
                        x1={padL}
                        x2={svgW - padR}
                        y1={y}
                        y2={y}
                        stroke="#1E293B"
                        strokeDasharray="3 3"
                      />
                      <text
                        x={padL - 8}
                        y={y + 3}
                        textAnchor="end"
                        className="fill-slate-400 font-mono text-[10px]"
                      >
                        {formatTick(val)}
                      </text>
                    </g>
                  );
                })}

                {/* Y-axis label */}
                <text
                  x={12}
                  y={padT + plotH / 2}
                  transform={`rotate(-90 12 ${padT + plotH / 2})`}
                  textAnchor="middle"
                  className="fill-slate-400 font-mono text-[10px]"
                >
                  MJy / sr
                </text>

                {/* Clipped & domain-clamped plot elements */}
                <g clipPath={`url(#${clipId})`}>
                  {/* Connecting line */}
                  {sortedPlotPoints.length > 1 && (
                    <polyline
                      fill="none"
                      stroke="#334155"
                      strokeWidth="1.5"
                      points={sortedPlotPoints
                        .map(
                          (p) =>
                            `${toX(p).toFixed(1)},${toY(
                              p.inspect.photometry.netSurfaceBrightness ?? 0
                            ).toFixed(1)}`
                        )
                        .join(' ')}
                    />
                  )}

                  {/* Points & 1-sigma error bars */}
                  {sortedPlotPoints.map((point) => {
                    const { obs, inspect } = point;
                    const val = inspect.photometry.netSurfaceBrightness ?? 0;
                    const rawSig = inspect.photometry.uncertaintySigma ?? 0;
                    const sig = Number.isFinite(rawSig) && rawSig > 0 ? rawSig : 0;
                    const cx = toX(point);
                    const cy = toY(val);
                    const yTop = toY(val + sig);
                    const yBot = toY(val - sig);
                    const color = BAND_COLORS[obs.bandpassName] || '#22D3EE';
                    const isActive = activeObs?.id === obs.id;

                    return (
                      <g
                        key={obs.id}
                        className="cursor-pointer"
                        onMouseEnter={() => setHoveredId(obs.id)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={() => onSelectObservation(obs.id)}
                      >
                        {sig > 0 && Math.abs(yBot - yTop) > 0.5 && (
                          <line
                            x1={cx}
                            x2={cx}
                            y1={yTop}
                            y2={yBot}
                            stroke={color}
                            strokeWidth="1.5"
                            opacity={0.65}
                          />
                        )}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isActive ? 6 : 4.5}
                          fill={color}
                          stroke={isActive ? '#FFFFFF' : '#0B1222'}
                          strokeWidth={isActive ? 2 : 1.5}
                        />
                      </g>
                    );
                  })}
                </g>

                {/* X-axis endpoints */}
                <text
                  x={padL}
                  y={svgH - 8}
                  textAnchor="start"
                  className="fill-slate-400 font-mono text-[10px]"
                >
                  {useWavelengthAxis
                    ? `${minLam.toFixed(2)} µm`
                    : sortedPlotPoints[0].obs.obsDateDisplay.slice(0, 10)}
                </text>
                {useWavelengthAxis && (
                  <text
                    x={padL + plotW / 2}
                    y={svgH - 8}
                    textAnchor="middle"
                    className="fill-slate-500 font-mono text-[10px]"
                  >
                    Wavelength (µm)
                  </text>
                )}
                {sortedPlotPoints.length > 1 && (
                  <text
                    x={svgW - padR}
                    y={svgH - 8}
                    textAnchor="end"
                    className="fill-slate-400 font-mono text-[10px]"
                  >
                    {useWavelengthAxis
                      ? `${maxLam.toFixed(2)} µm`
                      : sortedPlotPoints[sortedPlotPoints.length - 1].obs.obsDateDisplay.slice(0, 10)}
                  </text>
                )}
              </svg>
            )}

            {hoveredPoint && (
              <div className="pointer-events-none absolute right-2 top-2 rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 font-mono text-[11px] text-slate-200">
                <p className="font-semibold text-cyan-300">
                  {hoveredPoint.obs.bandpassName}
                  {hoveredPoint.obs.emCenterUm
                    ? ` · ${hoveredPoint.obs.emCenterUm.toFixed(3)} µm`
                    : ''}
                </p>
                <p>{hoveredPoint.obs.obsDateDisplay.slice(0, 16)} UTC</p>
                <p>
                  Net: {hoveredPoint.inspect.photometry.netSurfaceBrightness?.toFixed(4)} MJy/sr
                </p>
              </div>
            )}
          </div>
        </div>

        <p className="mt-3 border-t border-slate-800/80 pt-3 text-[11px] leading-relaxed text-slate-400">
          Scientific note: Apparent brightness differences across epochs can reflect different SPHEREx detector bands (D1–D6), spacecraft roll angle, or zodiacal residuals—compare within matching bands before inferring astrophysical variability.
        </p>
      </div>

      {/* 102-Band Spectral Window Card */}
      <div className="flex flex-col justify-between rounded-xl border border-slate-800/90 bg-[#0B1222] p-5 lg:col-span-5">
        <div>
          <h3 className="font-display text-base font-semibold text-slate-100">
            SPHEREx Spectral Coverage (102 Bands)
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
            Different wavelengths reveal different properties of celestial objects. By observing the same region across 6 detector arrays spanning 0.75–5.0 µm, SPHEREx probes stars, cool brown dwarfs, and cosmic ices.
          </p>

          {/* 6-Band Visual Bar & Real Measured Flux Comparison */}
          <div className="mt-4 space-y-2.5">
            {bandMeasurements.map((band) => {
              const isActive = activeObs?.bandpassName === band.id;
              const barPct =
                band.meanFlux !== null
                  ? Math.min(100, Math.max(8, (Math.abs(band.meanFlux) / maxBandFlux) * 100))
                  : 0;
              return (
                <div
                  key={band.id}
                  className={`rounded-lg border px-3 py-2 transition-colors ${
                    isActive
                      ? 'border-cyan-400/70 bg-slate-900/90'
                      : 'border-slate-800/80 bg-[#080E1B]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ backgroundColor: band.color }}
                      />
                      <span className="font-mono font-medium text-slate-100">{band.short}</span>
                      <span className="font-mono tabular-nums text-[11px] text-slate-400">
                        {band.min.toFixed(2)}–{band.max.toFixed(2)} µm
                      </span>
                    </div>
                    <span className="font-mono tabular-nums text-[11px] text-slate-300">
                      {band.meanFlux !== null
                        ? `${band.meanFlux.toFixed(3)} MJy/sr (n=${band.count})`
                        : 'Not yet sampled'}
                    </span>
                  </div>

                  <div className="mt-1.5 flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${barPct}%`,
                          backgroundColor: band.color,
                          opacity: band.meanFlux !== null ? 1 : 0.2,
                        }}
                      />
                    </div>
                    <span className="hidden truncate text-[11px] text-slate-400 sm:inline">
                      {band.science}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="mt-3 border-t border-slate-800/80 pt-3 text-[11px] text-slate-400">
          Only real measured fluxes from retrieved IRSA FITS cutouts are plotted above; unsampled bands remain unplotted.
        </p>
      </div>
    </div>
  );
}
