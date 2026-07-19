import { useEffect, useRef, useState } from 'react';
import { useAgent } from '../AgentContext';
import { Button, type Translate } from './ui';

const GB = 1024 * 1024 * 1024;
const TELEPORT_MS = 200;
const DONE_MS = 900;
const BUBBLE_DELAY_MS = 2500;
const BUBBLE_VISIBLE_MS = 6000;

type Phase = 'idle' | 'out' | 'in' | 'compressing' | 'done';
type Target = { kind: 'home' } | { kind: 'job'; id: string };

function anchorPoint(target: Target): { x: number; y: number } | null {
  if (target.kind === 'job') {
    const row = document.querySelector(`[data-job-id="${target.id}"]`);
    if (row) {
      const rect = row.getBoundingClientRect();
      return { x: rect.right - 70, y: rect.top - 50 };
    }
  }
  const start = document.querySelector('[data-mascot-anchor="start"]');
  if (start) {
    const rect = start.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - 26, y: rect.top - 52 };
  }
  const zone = document.querySelector('.add-files-section');
  if (zone) {
    const rect = zone.getBoundingClientRect();
    return { x: rect.right - 76, y: rect.top - 44 };
  }
  return null;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function Mascot({ t }: { t: Translate }) {
  const { state } = useAgent();
  const reduced = usePrefersReducedMotion();

  const demoEnabled =
    Boolean(import.meta.env.DEV) && window.location.search.includes('mascotDemo');
  const [demo, setDemo] = useState<{ running: boolean; big: boolean } | null>(null);

  const realActive = state.jobs.find(job => job.status === 'processing');
  const running = demo ? demo.running : state.running;
  const active = demo
    ? demo.running
      ? {
          id: state.jobs[0]?.id ?? '__demo__',
          originalSize: demo.big ? 2 * GB : 200 * 1024 * 1024
        }
      : undefined
    : realActive;

  // Keep pointing at the last processing job during the brief gap between files.
  const lastJobIdRef = useRef<string | null>(null);
  const jobId = running ? (active?.id ?? lastJobIdRef.current) : null;
  if (running && active) lastJobIdRef.current = active.id;
  else if (!running) lastJobIdRef.current = null;
  const targetKey = jobId ? `job:${jobId}` : 'home';

  const [phase, setPhase] = useState<Phase>('idle');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const targetRef = useRef<Target>({ kind: 'home' });
  const mountedOnceRef = useRef(false);

  useEffect(() => {
    const timers: number[] = [];
    const target: Target =
      targetKey === 'home' ? { kind: 'home' } : { kind: 'job', id: targetKey.slice(4) };
    const finalPhase: Phase = target.kind === 'job' ? 'compressing' : 'idle';
    const wasAtJob = targetRef.current.kind === 'job';
    const firstMount = !mountedOnceRef.current;
    mountedOnceRef.current = true;
    const land = () => {
      targetRef.current = target;
      const point = anchorPoint(target);
      if (point) setPos(point);
    };

    if (reduced) {
      land();
      setPhase(finalPhase);
      return;
    }
    const appear = () => {
      land();
      setPhase('in');
      timers.push(window.setTimeout(() => setPhase(finalPhase), TELEPORT_MS));
    };
    const teleport = () => {
      setPhase('out');
      timers.push(window.setTimeout(appear, TELEPORT_MS));
    };
    if (firstMount) appear();
    else if (target.kind === 'home' && wasAtJob) {
      setPhase('done');
      timers.push(window.setTimeout(teleport, DONE_MS));
    } else teleport();

    return () => timers.forEach(id => window.clearTimeout(id));
  }, [targetKey, reduced]);

  // Follow the anchor while stationary (scroll, resize, layout shifts).
  const scheduleRef = useRef<() => void>(() => {});
  useEffect(() => {
    let raf = 0;
    const update = () => {
      const current = phaseRef.current;
      if (current !== 'idle' && current !== 'compressing') return;
      const point = anchorPoint(targetRef.current);
      if (!point) return;
      setPos(prev =>
        prev && Math.abs(prev.x - point.x) < 1 && Math.abs(prev.y - point.y) < 1 ? prev : point
      );
    };
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    scheduleRef.current = schedule;
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    scheduleRef.current();
  });

  // One sarcastic line per compression session for files over 1 GB.
  const [bubble, setBubble] = useState(false);
  const bubbleShownRef = useRef(false);
  useEffect(() => {
    if (!running) bubbleShownRef.current = false;
  }, [running]);
  const bigFile = Boolean(active && active.originalSize > GB);
  const activeId = active?.id ?? null;
  useEffect(() => {
    if (phase !== 'compressing') {
      setBubble(false);
      return;
    }
    if (!bigFile || bubbleShownRef.current) return;
    const show = window.setTimeout(() => {
      bubbleShownRef.current = true;
      setBubble(true);
    }, BUBBLE_DELAY_MS);
    return () => window.clearTimeout(show);
  }, [phase, bigFile, activeId]);
  useEffect(() => {
    if (!bubble) return;
    const hide = window.setTimeout(() => setBubble(false), BUBBLE_VISIBLE_MS);
    return () => window.clearTimeout(hide);
  }, [bubble]);

  return (
    <>
      {pos && (
        <div
          className={`mascot mascot-${phase}`}
          style={{ transform: `translate3d(${Math.round(pos.x)}px, ${Math.round(pos.y)}px, 0)` }}
          aria-hidden="true"
        >
          {bubble && <div className="mascot-bubble">{t('mascotBigFile')}</div>}
          <div className="mascot-sprite">
            <span className="mascot-scorch" />
            {phase === 'compressing' && (
              <>
                <span className="mascot-ember e1" />
                <span className="mascot-ember e2" />
                <span className="mascot-ember e3" />
              </>
            )}
            <MascotSvg />
          </div>
        </div>
      )}
      {demoEnabled && (
        <div className="mascot-demo-panel">
          <span>Mascot demo</span>
          <Button variant="ghost" onClick={() => setDemo({ running: false, big: false })}>
            Idle
          </Button>
          <Button variant="ghost" onClick={() => setDemo({ running: true, big: false })}>
            Compress
          </Button>
          <Button variant="ghost" onClick={() => setDemo({ running: true, big: true })}>
            Big file
          </Button>
          <Button variant="ghost" onClick={() => setDemo(null)}>
            Live
          </Button>
        </div>
      )}
    </>
  );
}

function MascotSvg() {
  return (
    <svg className="mascot-svg" viewBox="0 0 64 72" aria-hidden="true">
      <defs>
        <linearGradient id="wm-flame" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#7557e8" />
          <stop offset="0.55" stopColor="#9b6ff3" />
          <stop offset="1" stopColor="#c06fef" />
        </linearGradient>
        <linearGradient id="wm-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b2a63" />
          <stop offset="1" stopColor="#241b3a" />
        </linearGradient>
        <radialGradient id="wm-core" cx="0.5" cy="0.8" r="0.75">
          <stop offset="0" stopColor="#ffd9a3" />
          <stop offset="0.45" stopColor="#e08bf2" />
          <stop offset="1" stopColor="#9b6ff3" />
        </radialGradient>
      </defs>
      <path
        className="m-flame"
        d="M32 3 C 38 12 46 17 46 30 C 46 39 40 46 32 46 C 24 46 18 39 18 30 C 18 17 26 12 32 3 Z"
        fill="url(#wm-flame)"
      />
      <path
        className="m-body"
        d="M32 28 C 43 28 50 37 50 49 C 50 61 42 68 32 68 C 22 68 14 61 14 49 C 14 37 21 28 32 28 Z"
        fill="url(#wm-body)"
      />
      <path
        className="m-inner-flame"
        d="M32 14 C 35 19 39 22 39 28 C 39 33 36 36 32 36 C 28 36 25 33 25 28 C 25 22 29 19 32 14 Z"
        fill="url(#wm-core)"
      />
      <g className="m-eyes">
        <ellipse cx="25" cy="47" rx="3.4" ry="4.8" fill="#f7f5ff" />
        <ellipse cx="39" cy="47" rx="3.4" ry="4.8" fill="#f7f5ff" />
        <rect className="m-lid m-lid-l" x="20.8" y="40.6" width="8.4" height="4" rx="2" fill="#2f2352" />
        <rect className="m-lid m-lid-r" x="34.8" y="40.6" width="8.4" height="4" rx="2" fill="#2f2352" />
      </g>
      <path
        className="m-mouth-idle"
        d="M28 57 Q32 58.2 36 57"
        stroke="#100b1c"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <path className="m-mouth-work" d="M27 55.5 Q32 61 37 55.5 Z" fill="#100b1c" />
    </svg>
  );
}
