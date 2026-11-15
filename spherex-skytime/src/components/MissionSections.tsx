import { ExternalLink } from 'lucide-react';
import observatoryUrl from '../assets/images/spherex_observatory_orbit_1794658522379.jpg';
import { SiGeneratedWatermark } from './SiGeneratedWatermark.tsx';

const HOW_IT_WORKS_STEPS = [
  {
    num: '01.',
    title: 'Choose a Region of the Sky',
    body: 'Enter Right Ascension and Declination coordinates, look up an astronomical object by name, or start with one of the five Space Apps challenge targets.',
  },
  {
    num: '02.',
    title: 'Retrieve SPHEREx Observations',
    body: 'Our backend queries NASA/IPAC IRSA’s Simple Image Access (SIA2) service to locate every SPHEREx Data Release 1 exposure covering your target.',
  },
  {
    num: '03.',
    title: 'Inspect Multi-Extension FITS Data',
    body: 'Each SPHEREx observation contains calibrated science images (MJy/sr), pixel uncertainty variances, data-quality flags, and zodiacal background models.',
  },
  {
    num: '04.',
    title: 'Explore Changes Across Time',
    body: 'Step through exposures chronologically using the time-lapse player, or compare two dates side-by-side and via adjustable opacity overlays.',
  },
  {
    num: '05.',
    title: 'Discover What Wavelengths Reveal',
    body: 'See how the same region looks across SPHEREx’s six near-infrared detector bands spanning 0.75 to 5.0 micrometers.',
  },
];

export function MissionSections() {
  return (
    <>
      {/* How It Works */}
      <section id="how-it-works" className="border-b border-slate-800/80 bg-[#060A14] py-16 sm:py-24">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-xs font-medium tracking-wider text-cyan-300">Workflow</p>
            <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-white sm:text-3xl [text-wrap:balance]">
              How SkyTime Turns Raw Survey Archives Into Exploration
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-300 sm:text-base">
              You do not need specialized astronomy software to inspect real space-telescope exposures. Five transparent steps connect your browser to NASA&apos;s infrared archive.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-5">
            {HOW_IT_WORKS_STEPS.map((step) => (
              <div
                key={step.num}
                className="flex flex-col justify-between rounded-xl border border-slate-800/90 bg-[#0B1222] p-5"
              >
                <div>
                  <p className="font-mono text-sm font-semibold text-cyan-300">{step.num}</p>
                  <h3 className="mt-3 font-display text-base font-semibold text-white">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* About SPHEREx */}
      <section id="about" className="border-b border-slate-800/80 bg-[#080E1B] py-16 sm:py-24">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 items-stretch gap-10 px-4 sm:px-6 lg:grid-cols-12 lg:gap-12 lg:px-8">
          <div className="lg:col-span-6">
            <div className="relative h-full min-h-[280px] overflow-hidden rounded-xl border border-slate-800 bg-[#050811]">
              <img
                src={observatoryUrl}
                alt="NASA SPHEREx space telescope in low Earth orbit with three conical photon shields"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
              <SiGeneratedWatermark />
            </div>
          </div>

          <div className="flex flex-col justify-center lg:col-span-6">
            <p className="text-xs font-medium tracking-wider text-cyan-300">About the Mission</p>
            <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-white sm:text-3xl [text-wrap:balance]">
              Why SPHEREx Surveys the Entire Sky in 102 Infrared Bands
            </h2>

            <div className="mt-4 space-y-4 text-sm leading-relaxed text-slate-300 sm:text-base">
              <p>
                <strong className="text-white">SPHEREx</strong> (Spectro-Photometer for the History
                of the Universe, Epoch of Reionization and Ices Explorer) is a NASA astrophysics
                mission that maps the entire sky every six months from sun-synchronous orbit.
              </p>
              <p>
                Using Linear Variable Filters across six detectors, it separates near-infrared light
                from <span className="font-mono text-cyan-300">0.75 to 5.0 µm</span> into{' '}
                <strong className="text-white">102 spectral channels</strong>—revealing water and
                carbon dioxide ices in star-forming clouds, the spectra of hundreds of millions of
                galaxies, and ultra-cold brown dwarfs near our Solar System.
              </p>
              <p>
                Because SPHEREx revisits every part of the sky across multiple survey passes,
                astronomers can compare observations over time to track fast-moving nearby stars,
                search for faint distant Solar System objects, and study variable stars.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer with Mandatory Astronomical Tools & Acknowledgements */}
      <footer className="bg-[#050811] py-12 text-xs text-slate-400">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-4 sm:px-6 md:grid-cols-12 lg:px-8">
          <div className="md:col-span-4">
            <p className="font-display text-base font-semibold text-white">SPHEREx SkyTime</p>
            <p className="mt-2 leading-relaxed text-slate-400">
              Built for NASA&apos;s Space Apps Challenge 2026 (&ldquo;Planet X and SPHEREx&rdquo;).
              All observation records, dates, coordinates, and calibrated images are retrieved live
              from the NASA/IPAC Infrared Science Archive (IRSA).
            </p>
            <p className="mt-4 font-semibold text-slate-200">SPHEREx Data Sources</p>
            <ul className="mt-2 space-y-1.5">
              <li>
                <a
                  href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200"
                >
                  <span>IRSA SPHEREx Mission Archive</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                <a
                  href="https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200"
                >
                  <span>SPHEREx DR1 Documentation</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                <a
                  href="https://caltech-ipac.github.io/irsa-tutorials/spherex/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200"
                >
                  <span>IRSA SPHEREx Tutorial Notebooks</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            </ul>
          </div>

          <div className="md:col-span-8">
            <h3 className="font-display text-sm font-semibold text-white">
              Astronomical Tools &amp; Acknowledgements
            </h3>
            <p className="mt-2 leading-relaxed text-slate-300">
              Interactive sky visualization powered by Aladin Lite, developed by the Centre de
              Données astronomiques de Strasbourg (CDS), Strasbourg astronomical data center.
            </p>

            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <li>
                <a
                  href="https://aladin.cds.unistra.fr/AladinLite/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200"
                >
                  <span>Aladin Lite</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                <a
                  href="https://cds-astro.github.io/aladin-lite/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200"
                >
                  <span>CDS Aladin Lite documentation</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/cds-astro/aladin-lite"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200"
                >
                  <span>Aladin Lite source code</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            </ul>

            <p className="mt-4 border-t border-slate-800/80 pt-3 leading-relaxed text-slate-400">
              Special thanks to the Aladin Lite development team and CDS for making this powerful
              astronomical visualization tool available to the scientific community and public.
            </p>
            <div className="mt-3 space-y-0.5 text-slate-400">
              <p>Crafted by Gopikrishna &amp; Khushleen</p>
              <p>© 2026 Team Lava Java. All rights reserved.</p>
              <p>Implemented using Google AI Studios</p>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
