import { useCallback, useEffect, useRef, useState } from 'react';
import { Navbar } from './components/Navbar.tsx';
import { HeroSection } from './components/HeroSection.tsx';
import { FeaturedGalleryModal } from './components/FeaturedGalleryModal.tsx';
import { SkyExplorer } from './components/SkyExplorer.tsx';
import { MissionSections } from './components/MissionSections.tsx';
import { CinematicIntro } from './components/CinematicIntro.tsx';
import type { ChallengeTarget, FeaturedObservation } from './types/spherex.ts';

interface FeaturedApiResponse {
  dateKey: string;
  localDate?: string;
  matchedLocalDate?: boolean;
  featuredIndex: number;
  items: FeaturedObservation[];
  isFallback: boolean;
}

function getLocalDateParams(): { localDate: string; tzOffsetMin: number } {
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
  return { localDate, tzOffsetMin: now.getTimezoneOffset() };
}

async function fetchJsonWithReason<T>(
  url: string,
  signal?: AbortSignal
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { signal });
    const text = await r.text();
    if (!r.ok) {
      return { ok: false, error: `Server responded with HTTP ${r.status}.` };
    }
    if (text.trimStart().startsWith('<')) {
      return { ok: false, error: 'Archive service returned an unexpected HTML response.' };
    }
    const parsed = JSON.parse(text) as T;
    return { ok: true, data: parsed };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'Request aborted.' };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error connecting to data API.',
    };
  }
}

export default function App() {
  const [showIntro, setShowIntro] = useState(true);
  const [featuredData, setFeaturedData] = useState<FeaturedApiResponse | null>(null);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [featuredError, setFeaturedError] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [targets, setTargets] = useState<ChallengeTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [isAladinFullscreen, setIsAladinFullscreen] = useState(false);
  const [externalLoadRequest, setExternalLoadRequest] = useState<{
    raInput: string;
    decInput: string;
    label?: string;
    preferObsId?: string;
    nonce: number;
  } | null>(null);

  const targetsTokenRef = useRef(0);
  const featuredTokenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ fullscreen?: boolean }>).detail;
      setIsAladinFullscreen(Boolean(detail?.fullscreen));
    };
    window.addEventListener('spherex:aladin-fullscreen', handler);
    return () => window.removeEventListener('spherex:aladin-fullscreen', handler);
  }, []);

  const fetchTargets = useCallback(async () => {
    const token = ++targetsTokenRef.current;
    setTargetsLoading(true);
    setTargetsError(null);

    const res = await fetchJsonWithReason<{ targets?: ChallengeTarget[] }>('/api/targets');
    if (!mountedRef.current || token !== targetsTokenRef.current) return;

    if (res.ok && Array.isArray(res.data.targets)) {
      setTargets(res.data.targets);
      setTargetsError(null);
    } else {
      setTargetsError(res.ok ? 'No challenge targets returned by API.' : res.error);
    }
    setTargetsLoading(false);
  }, []);

  const fetchFeatured = useCallback(async () => {
    const token = ++featuredTokenRef.current;
    setFeaturedLoading(true);
    setFeaturedError(null);

    const { localDate, tzOffsetMin } = getLocalDateParams();
    const qs = new URLSearchParams({
      localDate,
      tzOffsetMin: String(tzOffsetMin),
    });

    const res = await fetchJsonWithReason<FeaturedApiResponse>(`/api/featured?${qs.toString()}`);
    if (!mountedRef.current || token !== featuredTokenRef.current) return;

    if (res.ok && Array.isArray(res.data.items)) {
      setFeaturedData(res.data);
      setFeaturedError(null);
    } else {
      setFeaturedError(
        res.ok ? 'Featured observation archive returned empty data.' : res.error
      );
    }
    setFeaturedLoading(false);
  }, []);

  useEffect(() => {
    void fetchTargets();
    void fetchFeatured();
  }, [fetchTargets, fetchFeatured]);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleLoadFeaturedInExplorer = (item: FeaturedObservation) => {
    setExternalLoadRequest({
      raInput: item.observation.raHms,
      decInput: item.observation.decDms,
      label: item.title,
      preferObsId: item.observation.obsId,
      nonce: Date.now(),
    });
    scrollToSection('explore');
  };

  const featuredItem =
    featuredData && featuredData.items.length > 0
      ? featuredData.items[featuredData.featuredIndex] || featuredData.items[0]
      : null;

  return (
    <div className="min-h-screen bg-[#060A14] text-slate-100">
      {showIntro && <CinematicIntro onComplete={() => setShowIntro(false)} />}
      {!isAladinFullscreen && <Navbar onNavigate={scrollToSection} />}

      <main>
        <HeroSection
          featured={featuredItem}
          featuredLoading={featuredLoading}
          featuredError={featuredError}
          matchedLocalDate={Boolean(featuredData?.matchedLocalDate)}
          localDate={featuredData?.localDate || ''}
          onStartExploring={() => scrollToSection('explore')}
          onDiscoverMission={() => scrollToSection('about')}
          onOpenGallery={() => setGalleryOpen(true)}
          onLoadFeaturedInExplorer={handleLoadFeaturedInExplorer}
          onRetryFeatured={() => {
            void fetchFeatured();
            if (targets.length === 0) void fetchTargets();
          }}
        />

        <SkyExplorer
          targets={targets}
          targetsLoading={targetsLoading}
          targetsError={targetsError}
          onRetryTargets={fetchTargets}
          externalLoadRequest={externalLoadRequest}
        />

        <MissionSections />
      </main>

      <FeaturedGalleryModal
        open={galleryOpen}
        items={featuredData?.items || []}
        featuredIndex={featuredData?.featuredIndex || 0}
        featuredLoading={featuredLoading}
        featuredError={featuredError}
        dateKey={featuredData?.localDate || featuredData?.dateKey || ''}
        matchedLocalDate={Boolean(featuredData?.matchedLocalDate)}
        onClose={() => setGalleryOpen(false)}
        onSelectInExplorer={handleLoadFeaturedInExplorer}
        onRetryFeatured={fetchFeatured}
      />
    </div>
  );
}
