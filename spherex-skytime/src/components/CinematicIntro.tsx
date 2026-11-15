import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import heroPortraitUrl from '../assets/images/hero_spacecraft_portrait_1794735887580.jpg';
import astronautPortraitUrl from '../assets/images/astronaut_nebula_portrait_1794735888079.jpg';
import { SiGeneratedWatermark } from './SiGeneratedWatermark.tsx';

const STORAGE_KEY = 'spherex_astronaut_name';
const HERO_DURATION_MS = 6000;

type IntroStage = 'hero' | 'name' | 'astronaut';

interface CinematicIntroProps {
  onComplete: () => void;
}

function readStoredAstronautName(): string {
  try {
    return (window.localStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function saveStoredAstronautName(name: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

export function CinematicIntro({ onComplete }: CinematicIntroProps) {
  const initialStoredName = useRef<string>(readStoredAstronautName()).current;
  const [storedName, setStoredName] = useState<string>(initialStoredName);
  const [isReturningVisitor, setIsReturningVisitor] = useState<boolean>(Boolean(initialStoredName));
  const [stage, setStage] = useState<IntroStage>('hero');
  const [nameInput, setNameInput] = useState<string>('');
  const [isExiting, setIsExiting] = useState<boolean>(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const handleSkipOrFinish = useCallback(() => {
    if (isExiting) return;
    setIsExiting(true);
    window.setTimeout(() => {
      onComplete();
    }, 350);
  }, [isExiting, onComplete]);

  // Lock background scroll while intro is active
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Allow Escape key to skip at any point
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleSkipOrFinish();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSkipOrFinish]);

  // 6-second HeroImage splash timer -> Name prompt (new visitor) or Astronaut welcome back (returning)
  useEffect(() => {
    if (stage !== 'hero') return;
    const timer = window.setTimeout(() => {
      if (storedName) {
        setStage('astronaut');
      } else {
        setStage('name');
      }
    }, HERO_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [stage, storedName]);

  // Autofocus name input when entering Stage 2
  useEffect(() => {
    if (stage === 'name') {
      const t = window.setTimeout(() => nameInputRef.current?.focus(), 200);
      return () => window.clearTimeout(t);
    }
  }, [stage]);

  const handleSubmitName = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = nameInput.trim();
    if (!cleaned) return;
    saveStoredAstronautName(cleaned);
    setStoredName(cleaned);
    setIsReturningVisitor(false);
    setStage('astronaut');
  };

  const handleSwitchExplorer = () => {
    setNameInput('');
    setIsReturningVisitor(false);
    setStage('name');
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="SPHEREx SkyTime cinematic introduction"
      initial={{ opacity: 1 }}
      animate={{ opacity: isExiting ? 0 : 1 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      onClick={handleSkipOrFinish}
      className="fixed inset-0 z-50 flex flex-col justify-between overflow-hidden bg-[#060A14] text-slate-100 select-none cursor-pointer"
    >
      {/* Background Visual Layer */}
      <AnimatePresence mode="wait">
        {stage === 'hero' ? (
          <motion.div
            key="hero-bg"
            initial={{ opacity: 0, scale: 1.07 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              opacity: { duration: 0.8, ease: [0.16, 1, 0.3, 1] },
              scale: { duration: 6.2, ease: 'easeOut' },
            }}
            className="pointer-events-none absolute inset-0"
          >
            <picture className="block h-full w-full">
              <source media="(orientation: portrait)" srcSet={heroPortraitUrl} />
              <img
                src="/assets/aistudio/HeroImage_b1b86b6d.png"
                alt="Spacecraft bridge overlooking Earth and a glowing cosmic nebula"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover object-center"
              />
            </picture>
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-b from-[#060A14]/70 via-[#060A14]/30 to-[#060A14]/85"
            />
          </motion.div>
        ) : (
          <motion.div
            key="astronaut-bg"
            initial={{ opacity: 0, scale: 1.05 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              opacity: { duration: 0.9, ease: [0.16, 1, 0.3, 1] },
              scale: { duration: 8, ease: 'easeOut' },
            }}
            className="pointer-events-none absolute inset-0"
          >
            <picture className="block h-full w-full">
              <source media="(orientation: portrait)" srcSet={astronautPortraitUrl} />
              <img
                src="/assets/aistudio/AstranoutImage_19600c40.png"
                alt="Astronaut floating in deep space against a luminous nebula"
                referrerPolicy="no-referrer"
                className={`h-full w-full object-cover object-center transition-all duration-700 ${
                  stage === 'name' ? 'scale-105 brightness-75 blur-[2px]' : 'brightness-95'
                }`}
              />
            </picture>
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-b from-[#060A14]/65 via-[#060A14]/35 to-[#060A14]/85"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Bar: Brand & Accessible Skip Button */}
      <div className="relative z-10 flex items-center justify-between px-5 pt-5 sm:px-8 sm:pt-6">
        <span className="font-display text-sm font-semibold tracking-tight text-slate-200/90">
          SPHEREx SkyTime
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleSkipOrFinish();
          }}
          className="rounded-md border border-slate-700/70 bg-[#060A14]/70 px-3 py-1.5 text-xs font-medium text-slate-200 backdrop-blur-sm transition-colors hover:border-cyan-400/70 hover:text-white cursor-pointer whitespace-nowrap shrink-0"
        >
          Skip
        </button>
      </div>

      {/* Center Stage Content */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <AnimatePresence mode="wait">
          {stage === 'hero' && (
            <motion.div
              key="hero-content"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              className="max-w-3xl text-center"
            >
              <p className="font-mono text-xs uppercase tracking-[0.26em] text-cyan-300/90 sm:text-sm">
                NASA Near-Infrared Sky Archive
              </p>
              <h1 className="mt-3 font-display text-4xl font-bold tracking-tight text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.85)] sm:text-6xl lg:text-7xl [text-wrap:balance]">
                Entering Sky Time
              </h1>
            </motion.div>
          )}

          {stage === 'name' && (
            <motion.form
              key="name-form"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              onSubmit={handleSubmitName}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md cursor-default rounded-2xl border border-slate-700/80 bg-[#070C18]/88 p-6 shadow-2xl backdrop-blur-md sm:p-8"
            >
              <p className="font-mono text-xs uppercase tracking-widest text-cyan-300">
                Mission Check-In
              </p>
              <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-white sm:text-3xl">
                Enter Your Name
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                Personalize your deep-space exploration log, or click outside anytime to skip straight
                to the archive.
              </p>

              <div className="mt-6">
                <label htmlFor="astronaut-name-input" className="sr-only">
                  Your name
                </label>
                <input
                  ref={nameInputRef}
                  id="astronaut-name-input"
                  type="text"
                  maxLength={40}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Enter your name"
                  className="w-full rounded-lg border border-slate-700 bg-[#050811]/90 px-4 py-3 text-base text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <div className="mt-5 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={!nameInput.trim()}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-cyan-500 px-5 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                >
                  <span>Continue</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={handleSkipOrFinish}
                  className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-white cursor-pointer whitespace-nowrap"
                >
                  Skip
                </button>
              </div>
            </motion.form>
          )}

          {stage === 'astronaut' && (
            <motion.div
              key="astronaut-greeting"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-2xl cursor-default rounded-2xl border border-slate-700/70 bg-[#070C18]/72 px-6 py-8 text-center backdrop-blur-md sm:px-10 sm:py-10"
            >
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-300">
                {isReturningVisitor ? 'Navigator Recognized' : 'Crew Briefing'}
              </p>
              <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.8)] sm:text-5xl [text-wrap:balance]">
                {isReturningVisitor
                  ? `Welcome back, Astronaut ${storedName}!`
                  : `Hello Astronaut ${storedName}, ready to start your space journey?`}
              </h2>
              {isReturningVisitor && (
                <p className="mt-3 text-sm text-slate-300 sm:text-base">
                  Your sky deck is ready for another look across time and infrared bands.
                </p>
              )}

              <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={handleSkipOrFinish}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 px-7 py-3.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 cursor-pointer whitespace-nowrap"
                >
                  <span>Start Journey</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
                {isReturningVisitor && (
                  <button
                    type="button"
                    onClick={handleSwitchExplorer}
                    className="rounded-lg border border-slate-700/80 bg-[#060A14]/70 px-4 py-3.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white cursor-pointer whitespace-nowrap"
                  >
                    Switch Explorer Name
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Bar: Bottom-Left Loading... + Centered "Click anywhere to skip" + Bottom-Right SI Generated watermark */}
      <div className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 px-4 pb-4 sm:gap-3 sm:px-8 sm:pb-6">
        <div className="justify-self-start">
          {stage === 'hero' && (
            <div className="flex flex-col items-start gap-1.5">
              <span className="font-mono text-[11px] tracking-wider text-cyan-200 sm:text-sm">
                Loading...
              </span>
              <div className="h-1 w-16 overflow-hidden rounded-full bg-slate-800/90 sm:w-36">
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: HERO_DURATION_MS / 1000, ease: 'linear' }}
                  style={{ transformOrigin: 'left center' }}
                  className="h-full w-full bg-cyan-400"
                />
              </div>
            </div>
          )}
        </div>

        <p className="justify-self-center text-center text-[10px] font-medium tracking-wide text-slate-200/90 sm:text-xs whitespace-nowrap">
          Click anywhere to skip
        </p>

        <div className="justify-self-end">
          <SiGeneratedWatermark variant="inline" />
        </div>
      </div>
    </motion.div>
  );
}
