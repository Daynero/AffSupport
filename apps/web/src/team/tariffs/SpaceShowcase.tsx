import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Hexagon, FolderOpen, ListChecks, RefreshCw, UserPlus, Wallet } from 'lucide-react';
import type {
  SpaceAccess,
  SpaceAccessInvitation,
  TariffContactChannel
} from '@video-compressor/shared';
import { analytics } from '../../analytics/service';
import { useToasts } from '../../components/toast';
import { Alert, Button, Card, RadioGroup } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { supportConfig } from '../../lib/support';
import { ContactAdminButton } from './ContactAdminButton';

export interface SpaceShowcaseClient {
  joinWaitlist: (plan: string | null, channel: TariffContactChannel | null) => Promise<boolean>;
  acceptInvitation: (invitationId: string) => Promise<unknown>;
}

const FEATURES: ReadonlyArray<{ key: TranslationKey; icon: typeof FolderOpen }> = [
  { key: 'tariffShowcaseFeatureExplorer', icon: FolderOpen },
  { key: 'tariffShowcaseFeatureTasks', icon: ListChecks },
  { key: 'tariffShowcaseFeatureFinance', icon: Wallet },
  { key: 'tariffShowcaseFeatureUpdater', icon: RefreshCw }
];

export function SpaceShowcase({
  access,
  email: _email,
  client,
  onAccepted
}: {
  access: SpaceAccess;
  /** The signed-in address, used when the reply did not carry one. */
  email: string | null;
  client: SpaceShowcaseClient;
  onAccepted: (teamId: string) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const showcase = access.showcase;
  const plans = showcase?.plans ?? [];

  const [plan, setPlan] = useState<string>(
    () => plans.find(item => item.code === 'solo')?.code ?? 'solo'
  );
  const [accepting, setAccepting] = useState<string | null>(null);

  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    analytics.track('space_showcase_viewed', { screen_identifier: 'space_showcase' });
  }, []);

  const isSolo = plan === 'solo';

  const message = t('tariffShowcaseMessage', {
    plan: t(isSolo ? 'tariffShowcaseSolo' : 'tariffShowcaseTeam'),
    price: t(isSolo ? 'tariffShowcaseSoloPrice' : 'tariffShowcaseTeamPrice')
  });

  const contacted = (channel: TariffContactChannel) => {
    analytics.track('space_contact_clicked', {
      feature_identifier: plan ?? 'none',
      input_method: channel
    });
    // Record the chosen handoff; opening a channel does not prove delivery.
    void client.joinWaitlist(plan, channel).catch(() => undefined);
  };

  const accept = async (invitation: SpaceAccessInvitation) => {
    setAccepting(invitation.invitationId);
    try {
      await client.acceptInvitation(invitation.invitationId);
      push({ tone: 'success', text: t('teamToastInvitationAccepted') });
      onAccepted(invitation.teamId);
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setAccepting(null);
    }
  };

  const planOptions = useMemo(
    () =>
      [
        { value: 'solo', solo: true },
        { value: plans.find(item => item.code !== 'solo')?.code ?? 'lead', solo: false }
      ].map(item => ({
        value: item.value,
        label: (
          <span className="tariff-plan-heading">
            <span>{t(item.solo ? 'tariffShowcaseSolo' : 'tariffShowcaseTeam')}</span>
            <span className="tariff-plan-price">
              {!item.solo && <small>{t('tariffShowcaseFrom')} </small>}
              <strong>{item.solo ? '$20' : '$30'}</strong>{' '}
              <small>/ {t('tariffShowcaseMonth')}</small>
            </span>
            <span className="tariff-plan-indicator" aria-hidden="true">
              {plan === item.value && <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            </span>
          </span>
        ),
        description: (
          <span className="tariff-plan-details">
            <span>
              {t(item.solo ? 'tariffShowcaseSoloDescription' : 'tariffShowcaseTeamDescription')}
            </span>
            <span>{t(item.solo ? 'tariffShowcaseSoloSeats' : 'tariffShowcaseTeamSeats')}</span>
            {!item.solo && (
              <span>
                {t('tariffShowcaseExtraSeat')} <strong>+$5 / {t('tariffShowcaseMonth')}.</strong>
              </span>
            )}
          </span>
        )
      })),
    [plans, plan, t]
  );

  return (
    <section className="tariff-page tariff-showcase" aria-labelledby="tariff-showcase-title">
      {access.invitations.length > 0 && (
        <div className="flex flex-col gap-3" aria-label={t('teamInvitationInbox')}>
          {access.invitations.map(invitation =>
            invitation.blocked ? (
              <Alert key={invitation.invitationId} color="neutral" title={invitation.teamName}>
                {t('tariffInvitationBlocked', { space: invitation.teamName })}
              </Alert>
            ) : (
              <Card
                key={invitation.invitationId}
                role="panel"
                className="tariff-invitation"
                icon={<UserPlus size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
                title={t('tariffInvitationTitle', { space: invitation.teamName })}
                aside={
                  <Button
                    color="primary"
                    loading={accepting === invitation.invitationId}
                    onClick={() => void accept(invitation)}
                  >
                    {t('teamInvitationAccept')}
                  </Button>
                }
                description={invitation.inviterName ?? undefined}
              />
            )
          )}
        </div>
      )}

      <Card role="surface" className="tariff-showcase-card">
        <div className="tariff-showcase-intro">
          <div className="tariff-showcase-brand">
            <Hexagon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>SOTY</span>
          </div>
          <h1 id="tariff-showcase-title" className="tariff-showcase-title">
            {t('tariffShowcaseTitle')}
          </h1>
          <p className="tariff-showcase-lead">{t('tariffShowcaseLead').replace(' — ', ' —\n')}</p>
          <ul className="tariff-feature-list">
            {FEATURES.map(feature => (
              <li key={feature.key} className="tariff-feature">
                <span className="tariff-feature-icon" aria-hidden="true">
                  <feature.icon size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                </span>
                <span>
                  <strong>{t(feature.key)}</strong>
                  <span className="tariff-feature-description">
                    {t(`${feature.key}Description` as TranslationKey)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="tariff-showcase-offer">
          <h2>{t('tariffShowcasePlans')}</h2>
          <RadioGroup
            variant="cards"
            label={t('tariffShowcasePlans')}
            value={plan}
            options={planOptions}
            onChange={setPlan}
            className="tariff-plan-choice"
          />
          <ContactAdminButton
            contact={{
              ...showcase?.contact,
              telegram: supportConfig.spaceAdminTelegram,
              email: showcase?.contact.email ?? null
            }}
            directTelegram
            message={message}
            subject={t('tariffMessageSubject')}
            onContact={contacted}
            icon={false}
            size="lg"
            className="tariff-showcase-contact"
          />
          <p className="tariff-showcase-note">{t('tariffShowcaseContactNote')}</p>
        </div>
      </Card>
    </section>
  );
}
