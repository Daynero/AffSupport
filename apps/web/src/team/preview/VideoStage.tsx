import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { VolumeX } from 'lucide-react';
import { Button, Spinner } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { PreviewPoster } from './previewPoster';

/** The usual shape of a clip, for a viewer that has seen no picture of it yet. */
const DEFAULT_ASPECT = 16 / 9;

/**
 * The video viewer's frame (070, phase 9е).
 *
 * The owner, on the beta: it opened as a narrow player with "Preparing the file preview…", then
 * jumped wider, and then still waited for a press on play — "I opened it to watch it". So:
 *
 * - The frame has its final size from the first frame. Its shape is the tile's thumbnail's,
 *   which is the video's own and is known before a byte of the video arrives; with no thumbnail
 *   on record it is the common 16:9. When the clip's real size arrives and differs, the frame
 *   grows to it — the shape is a registered custom property, so it moves over `--dur-layout`
 *   rather than jumping (and does not move at all under reduced motion, where that is 1 ms).
 * - The wait is shown inside that frame, over the thumbnail, not as a sentence above nothing.
 * - It plays as soon as it can. With sound when the browser allows it — the press that opened
 *   it usually counts — and otherwise muted, with one obvious control to turn the sound on; any
 *   key or press elsewhere in the viewer turns it on as well.
 */
export function VideoStage({
  src,
  poster,
  waiting,
  onReady,
  onFailed
}: {
  /** The stream; null while it is still being granted. */
  src: string | null;
  poster: PreviewPoster | null;
  /** Nothing to watch yet: the wait is shown in the frame. */
  waiting: boolean;
  onReady: () => void;
  onFailed: () => void;
}) {
  const { t } = useI18n();
  const [aspect, setAspect] = useState(poster?.aspect ?? DEFAULT_ASPECT);
  const [posterFailed, setPosterFailed] = useState(false);
  const [mutedToPlay, setMutedToPlay] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  /** The stream playback was started for: a re-render, or a pause, never starts it again. */
  const startedFor = useRef<string | null>(null);

  const unmute = () => {
    if (video.current) video.current.muted = false;
    setMutedToPlay(false);
  };

  const play = (element: HTMLVideoElement) => {
    if (!src || startedFor.current === src) return;
    startedFor.current = src;
    const attempt = () => {
      try {
        return element.play() as Promise<void> | undefined;
      } catch {
        return undefined;
      }
    };
    attempt()?.catch((error: unknown) => {
      // Sound refused without a gesture: play silently and offer the sound.
      if (!(error instanceof DOMException) || error.name !== 'NotAllowedError') return;
      element.muted = true;
      setMutedToPlay(true);
      attempt()?.catch(() => undefined);
    });
  };

  // Muted to start: the first key or press anywhere in the viewer is the gesture the browser
  // wanted, so it brings the sound back — except a press on the player itself, which is the
  // player's (pause, seek, its own volume).
  useEffect(() => {
    if (!mutedToPlay) return;
    const root = stage.current?.closest('[role="dialog"]') ?? document;
    const restore = () => {
      if (video.current) video.current.muted = false;
      setMutedToPlay(false);
    };
    const onPress = (event: Event) => {
      if (event.target instanceof Node && video.current?.contains(event.target)) return;
      restore();
    };
    const onKey = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape') return;
      restore();
    };
    root.addEventListener('pointerdown', onPress, true);
    root.addEventListener('keydown', onKey, true);
    return () => {
      root.removeEventListener('pointerdown', onPress, true);
      root.removeEventListener('keydown', onKey, true);
    };
  }, [mutedToPlay]);

  const ready = Boolean(src) && !waiting;

  return (
    <div
      ref={stage}
      className="team-preview-stage"
      data-ready={ready || undefined}
      style={{ '--preview-aspect': String(aspect) } as CSSProperties}
    >
      {poster && !posterFailed && (
        <img
          className="team-preview-stage-poster"
          src={poster.src}
          alt=""
          aria-hidden="true"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setPosterFailed(true)}
        />
      )}
      {src && (
        <video
          ref={element => {
            video.current = element;
            element?.setAttribute('referrerpolicy', 'no-referrer');
          }}
          controls
          /* The browser's own menu offered "Download" under a heading
             that says this is a safe view, and a cast button that would
             send a private cut to whatever is on the network. */
          controlsList="nodownload noremoteplayback noplaybackrate"
          disablePictureInPicture
          playsInline
          preload="auto"
          src={src}
          onLoadedMetadata={event => {
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth > 0 && videoHeight > 0) setAspect(videoWidth / videoHeight);
          }}
          onLoadedData={event => {
            onReady();
            play(event.currentTarget);
          }}
          onCanPlay={event => {
            onReady();
            play(event.currentTarget);
          }}
          onVolumeChange={event => {
            if (!event.currentTarget.muted) setMutedToPlay(false);
          }}
          onError={onFailed}
        />
      )}
      {waiting && (
        <p className="team-preview-stage-status" aria-live="polite">
          <Spinner />
          {t('teamPreviewLoading')}
        </p>
      )}
      {mutedToPlay && (
        <Button
          className="team-preview-unmute"
          color="secondary"
          variant="solid"
          size="sm"
          leading={<VolumeX size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          onClick={unmute}
        >
          {t('teamPreviewUnmute')}
        </Button>
      )}
    </div>
  );
}
