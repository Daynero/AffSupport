import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, Check, Download, LoaderCircle } from 'lucide-react';
import { useI18n, type TranslationKey } from '../i18n';
import { Button } from '../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useOptionalUpdateCenter, type UpdateOffer } from './UpdateCenter';
import { tokenDuration } from './genie';

/** The «What's new» window, put away, lands here and asks the button to glow. */
export const UPDATE_BUTTON_GLOW = 'soty:update-button:glow';
/** How long a finished update keeps its check mark before the button leaves. */
const READY_VISIBLE_MS = 10_000;

function labelKey(offer: UpdateOffer): TranslationKey {
  switch (offer.phase) {
    case 'downloading':
      return 'updateButtonDownloading';
    case 'waiting':
      return 'updateButtonWaiting';
    case 'installing':
      return 'updateButtonInstalling';
    case 'attention':
      return 'updateButtonAttention';
    case 'ready':
      return 'updateButtonReady';
    default:
      return offer.installerStarted
        ? 'updateButtonOpenInstaller'
        : offer.installReady
          ? 'updateButtonInstall'
          : 'updateButtonUpdate';
  }
}

function hintKey(offer: UpdateOffer): TranslationKey {
  if (offer.phase === 'available')
    return offer.installerStarted
      ? 'updateHintOpenInstaller'
      : offer.required
        ? 'updateHintRequired'
        : 'updateHintAvailable';
  if (offer.phase === 'attention') return 'updateHintAttention';
  if (offer.phase === 'ready') return 'updateHintReady';
  return 'updateHintProgress';
}

/**
 * 074 US1 — the update stays in the header until it is installed.
 *
 * «Later» used to hide the offer for good, and the only other ways back were the
 * user menu and the account page, which people did not know about. The button
 * sits beside the agent's status on every page; while there is an offer, a
 * press starts the update at once, and while one runs it opens the details.
 */
export function HeaderUpdateButton({ narrow = false }: { narrow?: boolean }) {
  const center = useOptionalUpdateCenter();
  const { t } = useI18n();
  const [glow, setGlow] = useState(false);
  const [readyGone, setReadyGone] = useState<string | null>(null);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offer = center?.offer ?? null;
  const readyKey = offer?.phase === 'ready' ? `${offer.buildId}` : null;

  useEffect(() => {
    const onGlow = () => {
      setGlow(true);
      if (glowTimer.current) clearTimeout(glowTimer.current);
      glowTimer.current = setTimeout(
        () => setGlow(false),
        tokenDuration('--motion-update-glow') || 2000
      );
    };
    window.addEventListener(UPDATE_BUTTON_GLOW, onGlow);
    return () => {
      window.removeEventListener(UPDATE_BUTTON_GLOW, onGlow);
      if (glowTimer.current) clearTimeout(glowTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!readyKey) return;
    const timer = setTimeout(() => setReadyGone(readyKey), READY_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [readyKey]);

  if (!center || !offer) return null;
  if (offer.phase === 'ready' && readyGone === readyKey) return null;

  const label = t(labelKey(offer), { version: offer.version ?? '' });
  const hint = t(hintKey(offer), { version: offer.version ?? '' });
  const busy =
    offer.phase === 'downloading' || offer.phase === 'waiting' || offer.phase === 'installing';
  const tone =
    offer.phase === 'attention' || (offer.required && offer.phase === 'available')
      ? 'warning'
      : offer.phase === 'ready'
        ? 'success'
        : 'primary';
  const icon =
    offer.phase === 'attention' ? (
      <AlertTriangle size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
    ) : offer.phase === 'ready' ? (
      <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
    ) : busy && offer.fraction === null ? (
      <LoaderCircle
        className="update-button-spin"
        size={ICON_SIZE}
        strokeWidth={ICON_STROKE}
        aria-hidden="true"
      />
    ) : (
      <Download size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
    );
  const ring =
    offer.phase === 'downloading' && offer.fraction !== null
      ? ({ '--update-fraction': offer.fraction } as CSSProperties)
      : undefined;

  return (
    <span className="update-button-slot" style={ring}>
      <Button
        size="md"
        color={tone}
        variant={offer.phase === 'available' ? 'soft' : 'ghost'}
        className="update-button"
        aria-label={`${label}. ${hint}`}
        title={hint}
        data-update-button=""
        data-phase={offer.phase}
        data-glow={glow || undefined}
        data-ring={ring ? '' : undefined}
        leading={<span className="update-button-icon">{icon}</span>}
        onClick={() => {
          if (offer.phase === 'ready') {
            setReadyGone(readyKey);
            return;
          }
          if (offer.phase === 'available' && !offer.installerStarted) center.start();
          else center.openDetails();
        }}
      >
        {!narrow && <span className="update-button-text">{label}</span>}
      </Button>
      {offer.phase === 'available' && <i className="update-button-dot" aria-hidden="true" />}
    </span>
  );
}
