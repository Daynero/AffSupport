import { useId, useRef, useState, type ReactNode } from 'react';
import { Check, Info, Save, Settings2 } from 'lucide-react';
import { Alert, Button, IconButton, Popover } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

type Scope = 'offer' | 'workspace';
export interface LaunchDefaultsActionsProps {
  manage: boolean;
  offerName?: string;
  hasOffer: boolean;
  loading: boolean;
  loadError: boolean;
  buyerMissing: boolean;
  disabled: boolean;
  saveDisabled: Record<Scope, boolean>;
  /** Whether the form matches the profile saved for that scope right now. */
  savedScopes?: Record<Scope, boolean>;
  savingScope?: Scope;
  onSave: (scope: Scope) => void;
  onRetry: () => void;
  feedback?: ReactNode;
  primaryAction?: ReactNode;
}

export interface LaunchDefaultsProposalProps {
  offerName?: string;
  proposalSource?: Scope | 'builtin';
  loading: boolean;
  loadError: boolean;
  disabled: boolean;
  onApply: () => void;
  onKeep: () => void;
}

/**
 * «Застосувати налаштування офера?» — asked in place, under the offer that raised it.
 *
 * It was a modal in the middle of the form with a clear backdrop: easy to miss, and the
 * next click — usually on «Баєр», right after the offer — only dismissed it, so the buyer
 * list «did not open on the first click» (next QA 2026-11-21). Inline it blocks nothing;
 * leaving it unanswered keeps the form as it is, which is what «Залишити як є» does.
 */
export function LaunchDefaultsProposal({
  offerName,
  proposalSource,
  loading,
  loadError,
  disabled,
  onApply,
  onKeep
}: LaunchDefaultsProposalProps) {
  const { t } = useI18n();
  if (!proposalSource || proposalSource === 'builtin' || loading || loadError || disabled)
    return null;
  const title =
    proposalSource === 'offer' && offerName
      ? t('launchesDefaultsApplyOfferTitle', { value: offerName })
      : t('launchesDefaultsApplyTitle');
  return (
    <Alert
      color="info"
      title={title}
      aria-label={title}
      className="launch-defaults-proposal"
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onKeep}>
            {t('launchesDefaultsApplyNo')}
          </Button>
          <Button color="primary" variant="solid" size="sm" onClick={onApply}>
            {t('launchesDefaultsApplyYes')}
          </Button>
        </div>
      }
    >
      {t('launchesDefaultsApplyBody')}
    </Alert>
  );
}

/** Separate loading an existing profile from saving the settings on this form. */
export function LaunchDefaultsActions({
  manage,
  offerName,
  hasOffer,
  loading,
  loadError,
  buyerMissing,
  disabled,
  saveDisabled,
  savedScopes,
  savingScope,
  onSave,
  onRetry,
  primaryAction,
  feedback
}: LaunchDefaultsActionsProps) {
  const { t } = useI18n();
  const id = useId();
  const info = useRef<HTMLButtonElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  if (!manage && !loading && !loadError && !buyerMissing && !primaryAction) return null;
  return (
    <section
      className="launch-defaults-actions mx-auto w-full max-w-5xl"
      aria-label={t('launchesDefaultsTitle')}
    >
      {loading && (
        <p className="m-0 text-caption text-muted" role="status">
          {t('launchesDefaultsLoading')}
        </p>
      )}
      {loadError && (
        <div className="launch-defaults-error flex flex-wrap items-center gap-2">
          <p role="alert" className="m-0 text-caption">
            {t('launchesDefaultsLoadFailed')}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onRetry}
            aria-label={t('launchesDefaultsRetry')}
          >
            {t('launchesDefaultsRetryShort')}
          </Button>
        </div>
      )}
      {buyerMissing && (
        <p role="status" className="m-0 text-caption text-warning-text">
          {t('launchesDefaultBuyerMissing')}
        </p>
      )}
      {manage && (
        <div className="launch-defaults-heading flex items-center gap-2">
          <h3 className="m-0 text-label font-medium">{t('launchesDefaultsSaveHeading')}</h3>
          <IconButton
            ref={info}
            label={t('launchesDefaultsWhatSaved')}
            title=""
            variant="ghost"
            size="sm"
            aria-expanded={infoOpen}
            aria-haspopup="dialog"
            onClick={() => setInfoOpen(value => !value)}
          >
            <Info size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <Popover
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            anchor={info}
            label={t('launchesDefaultsWhatSaved')}
            className="max-w-sm p-3"
          >
            <p className="m-0 text-label">{t('launchesDefaultsProfileHelp')}</p>
          </Popover>
        </div>
      )}
      <div className="launch-defaults-scopes">
        {manage &&
          (['offer', 'workspace'] as const).map(scope => (
            <div key={scope} className="launch-defaults-scope">
              <Button
                variant="outline"
                leading={
                  scope === 'offer' ? (
                    <Save size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  ) : (
                    <Settings2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  )
                }
                aria-label={t(
                  scope === 'offer' ? 'launchesDefaultsOfferSave' : 'launchesDefaultsGeneralSave'
                )}
                aria-describedby={`${id}-${scope}`}
                title={scope === 'workspace' ? t('launchesDefaultsGeneralHelp') : undefined}
                loading={savingScope === scope}
                disabled={saveDisabled[scope]}
                onClick={() => onSave(scope)}
              >
                {t(
                  scope === 'offer' ? 'launchesDefaultsOfferShort' : 'launchesDefaultsGeneralShort'
                )}
              </Button>
              <p id={`${id}-${scope}`} className="m-0 break-words text-caption text-muted">
                {scope === 'offer'
                  ? hasOffer
                    ? t('launchesDefaultsOfferContext', { value: offerName ?? '' })
                    : t('launchesDefaultsChooseOffer')
                  : t('launchesDefaultsGeneralContext')}
              </p>
              {savedScopes?.[scope] && (
                <p
                  className="m-0 inline-flex items-center gap-1 text-caption text-success-text"
                  role="status"
                >
                  <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  {t(
                    scope === 'offer'
                      ? 'launchesDefaultsOfferMatches'
                      : 'launchesDefaultsGeneralMatches'
                  )}
                </p>
              )}
            </div>
          ))}
        {primaryAction && <div className="launch-detail-actions">{primaryAction}</div>}
      </div>
      {manage && feedback && <div className="launch-defaults-feedback">{feedback}</div>}
    </section>
  );
}
