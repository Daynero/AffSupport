import {
  type ChangeEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import { Maximize2, Pause, Play, Volume2 } from 'lucide-react';
import { SotyMark } from '../components/SotyLogo';
import type { Translate } from '../components/ui';

export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** How long a source may say nothing before it is given up on. */
const STALL_TIMEOUT_MS = 30_000;
/** Arrow keys on the seek slider move by this; a 10 ms step was a slider nobody could use. */
const SEEK_STEP_SECONDS = 5;
const SEEK_PAGE_SECONDS = 30;
const RATES = [0.75, 1, 1.25, 1.5, 2];
/** `0,75×` in a locale that writes decimals with a comma; the interface language sets it. */
function formatRate(value: number): string {
  return value.toLocaleString(document.documentElement.lang || undefined);
}

/**
 * The media element and its controls, and nothing else.
 *
 * Playback state used to live in the viewer, so every `timeupdate` — four a second — set
 * state on the component that also rendered both transcript columns. Here the four-a-second
 * churn stays inside a component that renders a handful of controls; the viewer reaches the
 * element through the ref for seeking and for the karaoke clock.
 */
export const TranscriptPlayer = forwardRef<
  HTMLVideoElement,
  {
    src: string;
    audioOnly: boolean;
    /** Shown under the controls when the document has no word timings to follow. */
    note?: string | null;
    onPlaybackChange?: () => void;
    /** The element gave up on its source; the viewer shows its retry path. */
    onError?: () => void;
    t: Translate;
  }
>(function TranscriptPlayer({ src, audioOnly, note, onPlaybackChange, onError, t }, ref) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => mediaRef.current as HTMLVideoElement, []);
  const [playback, setPlayback] = useState({
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    rate: 1,
    // Nothing decoded yet, or the network stalled mid-stream: the controls say so instead
    // of showing a pause icon over a dead slider.
    buffering: true
  });

  // Nothing decoded for this long is a dead source, not a slow one — before the first
  // frame or in the middle of the file alike. The element never reports it, so the
  // viewer's retry path is taken by the clock.
  useEffect(() => {
    if (!playback.buffering) return;
    // A hidden tab loads media at the browser's leisure; that is not a stall, so the clock
    // runs only while the page is on screen and starts over when it comes back.
    let timer: number | null = null;
    const arm = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== 'visible') return;
      timer = window.setTimeout(() => onError?.(), STALL_TIMEOUT_MS);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      document.removeEventListener('visibilitychange', arm);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [playback.buffering, onError]);

  const sync = () => {
    const media = mediaRef.current;
    if (!media) return;
    setPlayback({
      // Playing means frames are being produced, not that play() was called.
      playing: !media.paused && !media.ended && media.readyState >= 2,
      currentTime: media.currentTime,
      duration: Number.isFinite(media.duration) ? media.duration : 0,
      volume: media.volume,
      rate: media.playbackRate,
      buffering: media.readyState < 2 || (media.networkState === 2 && media.readyState < 3)
    });
    onPlaybackChange?.();
  };
  const toggle = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => {});
    else media.pause();
  };
  const seek = (event: ChangeEvent<HTMLInputElement>) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Number(event.target.value);
    sync();
  };
  const seekByKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const media = mediaRef.current;
    if (!media) return;
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? SEEK_STEP_SECONDS
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -SEEK_STEP_SECONDS
          : event.key === 'PageUp'
            ? SEEK_PAGE_SECONDS
            : event.key === 'PageDown'
              ? -SEEK_PAGE_SECONDS
              : 0;
    if (delta === 0) return;
    event.preventDefault();
    const duration = Number.isFinite(media.duration) ? media.duration : playback.duration;
    media.currentTime = Math.max(0, Math.min(duration || 0, media.currentTime + delta));
    sync();
  };
  const volume = (event: ChangeEvent<HTMLInputElement>) => {
    const media = mediaRef.current;
    if (!media) return;
    media.volume = Number(event.target.value);
    sync();
  };
  const rate = (event: ChangeEvent<HTMLSelectElement>) => {
    const media = mediaRef.current;
    if (!media) return;
    media.playbackRate = Number(event.target.value);
    sync();
  };
  const fullscreen = () => {
    const element = playerRef.current;
    if (element?.requestFullscreen) void element.requestFullscreen().catch(() => {});
  };

  return (
    <div ref={playerRef} className={`transcript-player${audioOnly ? ' audio-only' : ''}`}>
      <video
        ref={mediaRef}
        className="transcript-preview-media"
        src={src}
        playsInline
        preload="metadata"
        onLoadedMetadata={sync}
        onDurationChange={sync}
        onTimeUpdate={sync}
        onPlay={sync}
        onPause={sync}
        onEnded={sync}
        onVolumeChange={sync}
        onRateChange={sync}
        onWaiting={sync}
        onCanPlay={sync}
        onPlaying={sync}
        onStalled={sync}
        onError={onError}
      />
      {audioOnly && (
        <div className="transcript-audio-poster" aria-hidden="true">
          <span className="transcript-audio-mark">
            <SotyMark size={38} />
          </span>
          <span className={`transcript-audio-bars${playback.playing ? ' is-playing' : ''}`}>
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
      <div className="transcript-player-controls">
        <button
          type="button"
          className="transcript-player-icon"
          onClick={toggle}
          aria-label={
            playback.playing ? t('transcriptionPlayerPause') : t('transcriptionPlayerPlay')
          }
        >
          {playback.playing ? (
            <Pause size={18} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Play size={18} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
        {/* Not a live region: a clock that announces every tick can never be interrupted. */}
        <span className="transcript-player-time">
          {playback.buffering && playback.duration === 0
            ? t('transcriptionPlayerLoading')
            : `${formatMediaTime(playback.currentTime)} / ${formatMediaTime(playback.duration)}`}
        </span>
        <input
          className="transcript-player-seek"
          type="range"
          min="0"
          max={Math.max(0, playback.duration)}
          step="0.01"
          value={Math.min(playback.currentTime, playback.duration || 0)}
          onChange={seek}
          onKeyDown={seekByKey}
          aria-label={t('transcriptionPlayerSeek')}
        />
        <label className="transcript-player-volume">
          <Volume2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="visually-hidden">{t('transcriptionPlayerVolume')}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={playback.volume}
            aria-label={t('transcriptionPlayerVolume')}
            onChange={volume}
          />
        </label>
        <label className="transcript-player-rate">
          <span className="visually-hidden">{t('transcriptionPlayerSpeed')}</span>
          <select value={playback.rate} onChange={rate}>
            {RATES.map(value => (
              <option key={value} value={value}>
                {formatRate(value)}×
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="transcript-player-icon"
          onClick={fullscreen}
          aria-label={t('transcriptionPlayerFullscreen')}
        >
          <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {note && <p className="transcript-preview-note">{note}</p>}
    </div>
  );
});
