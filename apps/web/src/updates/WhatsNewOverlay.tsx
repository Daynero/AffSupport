import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useAgent } from '../AgentContext';
import { analytics } from '../analytics/service';
import { useI18n } from '../i18n';
import { localizedReleaseSummary, resolveInstallerDownload } from '../release-manifest';
import { Button, IconButton } from '../components/ui/index';
import { useDialogBehaviour } from '../components/ui/Overlay';
import { InstallerDownload } from '../components/InstallerDownload';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { OPEN_WHATS_NEW, useOptionalUpdateCenter } from './UpdateCenter';
import { UPDATE_BUTTON_GLOW } from './HeaderUpdateButton';
import { genieInto, prefersReducedMotion, tokenDuration } from './genie';
import { releaseHighlight } from './release-highlights';
import { UpdateArt } from './UpdateArt';
import './update-center.css';

const SEEN_KEY = 'soty.whats-new.seen.v1';
/** How often a waiting window looks again for its turn (another dialog may be up). */
const TURN_POLL_MS = 2_000;

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(buildId: string) {
  try {
    localStorage.setItem(SEEN_KEY, buildId);
  } catch {
    /* shown again next time: better than never */
  }
}

/** Another dialog is up (onboarding, a confirmation): the update waits its turn. */
function anotherDialogOpen(own: HTMLElement | null): boolean {
  return [...document.querySelectorAll('[aria-modal="true"]')].some(node => node !== own);
}

function updateButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-update-button]');
}

/**
 * 074 US2 — the first sight of a new build: a picture, the version, a few lines,
 * «Update» and «Later». Once per build in this browser. «Later» draws the window
 * into the header's update button (the genie) so the eye sees where the update
 * went; «Update» just fades it and the update starts.
 */
export function WhatsNewOverlay() {
  const center = useOptionalUpdateCenter();
  const agent = useAgent();
  const { t, language } = useI18n();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState<'fade' | 'genie' | null>(null);
  const [seen, setSeen] = useState<string | null>(readSeen);
  const offer = center?.offer ?? null;
  const offerable =
    offer?.phase === 'available' && !offer.installerStarted && Boolean(offer.buildId);
  const manifest = agent.releaseManifest.status === 'ready' ? agent.releaseManifest.manifest : null;

  const show = useCallback(
    (automatic: boolean) => {
      if (!offer?.buildId) return;
      setOpen(true);
      setLeaving(null);
      writeSeen(offer.buildId);
      setSeen(offer.buildId);
      if (automatic) {
        analytics.track('update_available', {});
        analytics.track('update_prompt_shown', {});
      }
    },
    [offer?.buildId]
  );

  // The first time this build is offered here, once nothing else holds the screen.
  useEffect(() => {
    if (open || !offerable || !offer?.buildId || seen === offer.buildId) return;
    const attempt = () => {
      if (anotherDialogOpen(null)) return false;
      show(true);
      return true;
    };
    if (attempt()) return;
    const timer = window.setInterval(() => {
      if (attempt()) window.clearInterval(timer);
    }, TURN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [offer?.buildId, offerable, open, seen, show]);

  // Asked for: the installer's processor choice lives here.
  useEffect(() => {
    const onOpen = () => show(false);
    window.addEventListener(OPEN_WHATS_NEW, onOpen);
    return () => window.removeEventListener(OPEN_WHATS_NEW, onOpen);
  }, [show]);

  const finish = useCallback((glow: boolean) => {
    setOpen(false);
    setLeaving(null);
    if (glow) window.dispatchEvent(new Event(UPDATE_BUTTON_GLOW));
  }, []);

  const leave = useCallback(
    (how: 'fade' | 'genie') => {
      if (leaving) return;
      setLeaving(how);
      const node = panel.current;
      const target = how === 'genie' ? updateButton() : null;
      if (how === 'genie' && node && target && !prefersReducedMotion()) {
        void genieInto(node, target).then(done => {
          if (done) finish(true);
          else window.setTimeout(() => finish(true), tokenDuration('--motion-slow'));
        });
        return;
      }
      window.setTimeout(() => finish(how === 'genie'), tokenDuration('--motion-slow'));
    },
    [finish, leaving]
  );

  const later = useCallback(() => {
    analytics.track('update_dismissed', {});
    leave('genie');
  }, [leave]);

  // An update started elsewhere (the header, another tab) closes the offer.
  useEffect(() => {
    if (open && !leaving && offer && offer.phase !== 'available') leave('fade');
  }, [leave, leaving, offer, open]);

  useDialogBehaviour({
    surface: panel,
    active: open,
    onClose: later,
    initialFocus: '[data-whats-new-primary]',
    returnFocus: updateButton()
  });

  if (!open || !center || !offer || typeof document === 'undefined') return null;

  const highlight = releaseHighlight(offer.version);
  const words = highlight?.[language === 'uk' ? 'uk' : 'en'];
  const title = words?.title ?? t('whatsNewTitle', { version: offer.version ?? '' });
  const summary = localizedReleaseSummary(manifest, language) ?? t('whatsNewFallbackBody');
  const installer = offer.channel === 'installer';
  const choice =
    installer && resolveInstallerDownload(manifest, agent.agentRuntime).status !== 'available';

  return createPortal(
    <div className="whats-new-overlay" data-leaving={leaving ?? undefined}>
      <div className="whats-new-backdrop" aria-hidden="true" onMouseDown={() => later()} />
      <div
        ref={panel}
        className="whats-new-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <IconButton
          className="whats-new-close"
          size="lg"
          label={t('supportClose')}
          title=""
          onClick={later}
        >
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <div className="whats-new-art">
          {highlight?.image ? <img src={highlight.image} alt="" /> : <UpdateArt />}
        </div>
        <div className="whats-new-body">
          <span className="whats-new-eyebrow">{t('whatsNewEyebrow')}</span>
          <h2 id={titleId}>{title}</h2>
          {words?.points.length ? (
            <ul className="whats-new-list">
              {words.points.map(point => (
                <li key={point}>
                  <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="prose">{summary}</p>
          )}
          <small className="whats-new-note">
            {t(installer ? 'whatsNewInstallerNote' : 'whatsNewNativeNote')}
          </small>
        </div>
        <div className="whats-new-actions">
          <Button color="neutral" variant="ghost" onClick={later}>
            {t('whatsNewLater')}
          </Button>
          {choice ? (
            <InstallerDownload intent="update" onDownload={() => leave('fade')}>
              {t('whatsNewUpdate')}
            </InstallerDownload>
          ) : (
            <Button
              color="primary"
              data-whats-new-primary=""
              onClick={() => {
                center.start();
                leave('fade');
              }}
            >
              {t('whatsNewUpdate')}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
