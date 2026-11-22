/**
 * 064: чарунки — the AI balance, where a person can see it. One chip with the number, in the
 * header and in the assistant's window; it opens the same short card: how many there are, which
 * part renews tonight, which part is bonus and stays. No price list: the price of every paid
 * action is on its own button, before it is pressed.
 */
import { useRef, useState } from 'react';
import { useOptionalAuth } from '../auth/AuthContext';
import { Button, Popover, Progress } from '../components/ui/index.js';
import { CreditIcon } from '../components/icons.js';
import { creditsCountKey, useI18n } from '../i18n';
import { useBrowserRoute } from '../lib/navigation';
import { parseTeamRoute } from '../team/routes';
import { kyivTime, useCredits } from './store';

export interface CreditsButtonProps {
  /** `compact` is the assistant window's chip: the number only. */
  compact?: boolean;
  /** Where the card offers to open the assistant; false inside the assistant itself. */
  offerAssistant?: boolean;
}

export function CreditsButton({ compact = false, offerAssistant = true }: CreditsButtonProps) {
  const { t, language } = useI18n();
  const signedIn = Boolean(useOptionalAuth()?.user);
  const credits = useCredits(signedIn);
  const route = useBrowserRoute();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!signedIn) return null;
  const status = credits.status;
  const here = parseTeamRoute(route);
  const inSpace = here?.kind === 'space';
  const available = status?.available ?? null;
  const label =
    available === null
      ? t('creditsTitle')
      : t(creditsCountKey(language, available), { count: available });
  const percent = status && status.grant > 0 ? Math.round((status.daily / status.grant) * 100) : 0;
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="soft"
        color="primary"
        className={compact ? 'credits-chip is-compact' : 'credits-chip'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        // Larger than the 16 px of a plain icon: the cell's frame takes room, and at 16 the sparkle
        // inside read as a dot next to the number (owner, 2026-11-22).
        leading={<CreditIcon size={19} />}
        onClick={() => setOpen(value => !value)}
      >
        {compact ? (available ?? '—') : label}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement="bottom-end"
        label={t('creditsTitle')}
      >
        <div className="credits-panel">
          {status ? (
            <>
              <p className="credits-panel-total">{label}</p>
              <div className="credits-panel-part">
                <div className="credits-panel-row">
                  <span>{t('creditsDaily')}</span>
                  <strong>{t('creditsOf', { value: status.daily, grant: status.grant })}</strong>
                </div>
                <Progress value={percent} size="xs" color="primary" decorative />
                <p className="credits-panel-line">
                  {t('creditsResets', { time: kyivTime(status.resetsAt, language) })}
                </p>
              </div>
              <div className="credits-panel-part">
                <div className="credits-panel-row">
                  <span>{t('creditsBonus')}</span>
                  <strong>{status.bonus}</strong>
                </div>
                <p className="credits-panel-line">{t('creditsBonusNote')}</p>
              </div>
              {!status.paidOpen && (
                <p className="credits-panel-line is-warning">{t('creditsMonthClosed')}</p>
              )}
              <p className="credits-panel-line">{t('creditsWhere')}</p>
            </>
          ) : (
            <p className="credits-panel-line">{t('creditsUnavailable')}</p>
          )}
          {offerAssistant &&
            (inSpace ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new Event('soty:open-assistant'));
                }}
              >
                {t('creditsOpenAssistant')}
              </Button>
            ) : (
              <p className="credits-panel-line">{t('creditsPickSpace')}</p>
            ))}
        </div>
      </Popover>
    </>
  );
}
