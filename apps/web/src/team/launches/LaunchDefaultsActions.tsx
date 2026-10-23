import { useId, useRef, useState, type ReactNode } from 'react';
import { Info, RotateCcw, Save, Settings2 } from 'lucide-react';
import { Button, IconButton, Popover } from '../../components/ui/index';
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
  proposalSource?: Scope | 'builtin';
  disabled: boolean;
  saveDisabled: Record<Scope, boolean>;
  savingScope?: Scope;
  onSave: (scope: Scope) => void;
  onApply: () => void;
  onKeep: () => void;
  onRetry: () => void;
  feedback?: ReactNode;
  primaryAction?: ReactNode;
}

/** Separate loading an existing profile from saving the settings on this form. */
export function LaunchDefaultsActions({
  manage,
  offerName,
  hasOffer,
  loading,
  loadError,
  buyerMissing,
  proposalSource,
  disabled,
  saveDisabled,
  savingScope,
  onSave,
  onApply,
  onKeep,
  onRetry,
  primaryAction,
  feedback
}: LaunchDefaultsActionsProps) {
  const { t } = useI18n();
  const id = useId();
  const info = useRef<HTMLButtonElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const proposal = proposalSource && proposalSource !== 'builtin' && !loading && !loadError;
  if (!manage && !proposal && !loading && !loadError && !buyerMissing && !primaryAction)
    return null;
  return (
    <section className="launch-defaults-actions" aria-label={t('launchesDefaultsTitle')}>
      {loading && (
        <p className="m-0 text-caption text-muted" role="status">
          {t('launchesDefaultsLoading')}
        </p>
      )}
      {loadError && (
        <div className="flex flex-wrap items-center gap-2">
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
      {proposal && (
        <div className="launch-defaults-proposal">
          <div className="min-w-0">
            <p className="m-0 break-words text-label font-medium">
              {proposalSource === 'offer'
                ? t('launchesDefaultsAvailableOffer', { value: offerName ?? '' })
                : t('launchesDefaultsAvailableGeneral')}
            </p>
            <p id={`${id}-replace`} className="m-0 text-caption text-muted">
              {t('launchesDefaultsReplaceHint')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              leading={<RotateCcw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              aria-label={t(
                proposalSource === 'offer'
                  ? 'launchesDefaultsApplyOffer'
                  : 'launchesDefaultsApplyGeneral'
              )}
              aria-describedby={`${id}-replace`}
              disabled={disabled}
              onClick={onApply}
            >
              {t('launchesDefaultsApplyShort')}
            </Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={onKeep}>
              {t('launchesDefaultsKeep')}
            </Button>
          </div>
        </div>
      )}
      {manage && (
        <div className="flex items-center gap-2">
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
                color={scope === 'offer' ? 'success' : 'neutral'}
                variant={scope === 'offer' ? 'solid' : 'outline'}
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
            </div>
          ))}
        {primaryAction && <div className="launch-detail-actions">{primaryAction}</div>}
      </div>
      {manage && feedback}
    </section>
  );
}
