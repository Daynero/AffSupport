/**
 * 064: «Чарунки · N» in the main header — today's credits, when they renew, what costs what, the
 * last charges, and the way to the launch assistant of the open space. The number is the same
 * one the assistant and translation show (credits/store).
 */
import { Coins } from 'lucide-react';
import { useRef, useState } from 'react';
import { useOptionalAuth } from '../auth/AuthContext';
import { Button, Popover, Progress } from '../components/ui/index.js';
import { ICON_SIZE, ICON_STROKE } from '../components/icons.js';
import { useI18n } from '../i18n';
import { navigateTo, useBrowserRoute } from '../lib/navigation';
import { buildTeamRoute, parseTeamRoute } from '../team/routes';
import { kyivTime, useCredits } from './store';

export function CreditsButton() {
  const { t, language } = useI18n();
  const signedIn = Boolean(useOptionalAuth()?.user);
  const credits = useCredits(signedIn);
  const route = useBrowserRoute();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!signedIn) return null;
  const status = credits.status;
  const here = parseTeamRoute(route);
  const spaceId = here?.kind === 'space' ? here.spaceId : null;
  const percent =
    status && status.grant > 0 ? Math.round((status.available / status.grant) * 100) : 0;
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="soft"
        aria-haspopup="dialog"
        aria-expanded={open}
        leading={<Coins size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        onClick={() => setOpen(value => !value)}
      >
        {t('creditsButton', { count: status ? status.available : '—' })}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement="bottom-start"
        label={t('creditsTitle')}
      >
        <div className="credits-panel">
          <p className="credits-panel-line">{t('creditsIntro')}</p>
          {status ? (
            <>
              <div>
                <strong>
                  {t('creditsToday', { available: status.available, grant: status.grant })}
                </strong>
                <Progress value={percent} size="sm" color="success" decorative />
                <p className="credits-panel-line">
                  {t('creditsResets', { time: kyivTime(status.resetsAt, language) })}
                </p>
              </div>
              {!status.paidOpen && <p className="credits-panel-line">{t('creditsMonthClosed')}</p>}
              <p className="credits-panel-line">{t('creditsPrices')}</p>
              {status.recent.length > 0 && (
                <div>
                  <p className="credits-panel-line">{t('creditsRecent')}</p>
                  <ul className="credits-panel-recent">
                    {status.recent.map((entry, index) => (
                      <li key={index}>
                        {`${t(entry.feature === 'launch_assistant' ? 'creditsFeatureAssistant' : 'creditsFeatureTranslation')} · ${entry.kind === 'refund' ? `+${entry.amount} ${t('creditsRefund')}` : `−${entry.amount}`} · ${new Date(entry.at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="credits-panel-line">{t('creditsUnavailable')}</p>
          )}
          {spaceId ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setOpen(false);
                navigateTo(buildTeamRoute({ spaceId, section: 'launches' }));
                // The panel mounts with the section; focus the field once it is there.
                setTimeout(() => window.dispatchEvent(new Event('soty:open-assistant')), 0);
              }}
            >
              {t('creditsOpenAssistant')}
            </Button>
          ) : (
            <p className="credits-panel-line">{t('creditsPickSpace')}</p>
          )}
        </div>
      </Popover>
    </>
  );
}
