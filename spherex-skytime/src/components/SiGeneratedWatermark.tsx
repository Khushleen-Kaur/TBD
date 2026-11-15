interface SiGeneratedWatermarkProps {
  variant?: 'overlay' | 'inline' | 'compact';
  className?: string;
}

export function SiGeneratedWatermark({
  variant = 'overlay',
  className = '',
}: SiGeneratedWatermarkProps) {
  const baseClasses =
    'pointer-events-none select-none font-mono tracking-wider text-slate-200/90 border border-white/15 bg-[#050811]/72 backdrop-blur-xs whitespace-nowrap';

  if (variant === 'inline') {
    return (
      <span
        title="SuperIntelligence Generated"
        aria-label="SI Generated (SuperIntelligence Generated)"
        className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium sm:text-[11px] ${baseClasses} ${className}`}
      >
        SI Generated
      </span>
    );
  }

  if (variant === 'compact') {
    return (
      <span
        title="SuperIntelligence Generated"
        aria-label="SI Generated (SuperIntelligence Generated)"
        className={`absolute bottom-1 right-1 z-10 rounded px-1 py-0.5 text-[8px] font-medium leading-none ${baseClasses} ${className}`}
      >
        SI Generated
      </span>
    );
  }

  return (
    <span
      title="SuperIntelligence Generated"
      aria-label="SI Generated (SuperIntelligence Generated)"
      className={`absolute bottom-2.5 right-2.5 z-10 rounded px-2 py-0.5 text-[10px] font-medium sm:bottom-3 sm:right-3 sm:text-[11px] ${baseClasses} ${className}`}
    >
      SI Generated
    </span>
  );
}
