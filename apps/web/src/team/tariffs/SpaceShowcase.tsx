import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  FolderOpen,
  ListChecks,
  RefreshCw,
  UserPlus,
  Users,
  Wallet
} from 'lucide-react';
import type {
  SpaceAccess,
  SpaceAccessInvitation,
  TariffContactChannel,
  TariffPlan
} from '@video-compressor/shared';
import { analytics } from '../../analytics/service';
import { useToasts } from '../../components/toast';
import { Alert, Button, Card, IconButton, RadioGroup } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { ContactAdminButton } from './ContactAdminButton';
import { copyText } from './contactLinks';
import { formatTariffMoment } from './format';

/**
 * The showcase (034, US7): what a space is, for someone who does not have one.
 *
 * A page, not a modal — it is where `/team` leads for this person, and a page
 * can be read, linked and come back to. One action on it: write to the
 * administrator. Choosing where to write is the request (US7.3), and the page
 * then says what was asked and when, with a way to write again.
 *
 * An invitation outranks all of it (US7.4): accepted, it opens a space without
 * a tariff of one's own, so it is the first thing on the page.
 *
 * No prices, anywhere (FR-011): a plan is its name, its words and its seats.
 */

export interface SpaceShowcaseClient {
  joinWaitlist: (plan: string | null, channel: TariffContactChannel | null) => Promise<boolean>;
  acceptInvitation: (invitationId: string) => Promise<unknown>;
}

const FEATURES: ReadonlyArray<{ key: TranslationKey; icon: typeof FolderOpen }> = [
  { key: 'tariffShowcaseFeatureExplorer', icon: FolderOpen },
  { key: 'tariffShowcaseFeatureTasks', icon: ListChecks },
  { key: 'tariffShowcaseFeatureFinance', icon: Wallet },
  { key: 'tariffShowcaseFeatureUpdater', icon: RefreshCw },
  { key: 'tariffShowcaseFeaturePeople', icon: Users }
];

export function SpaceShowcase({
  access,
  email: emailFallback,
  client,
  onAccepted
}: {
  access: SpaceAccess;
  /** The signed-in address, used when the reply did not carry one. */
  email: string | null;
  client: SpaceShowcaseClient;
  onAccepted: (teamId: string) => void;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const showcase = access.showcase;
  const plans = showcase?.plans ?? [];
  const email = showcase?.email || emailFallback || '';
  const request = showcase?.request ?? null;

  const [plan, setPlan] = useState<string | null>(
    () =>
      plans.find(item => item.code === request?.planInterest)?.code ??
      plans.find(item => item.highlight)?.code ??
      plans[0]?.code ??
      null
  );
  // What this tab sent; the server's record wins once the next poll brings it.
  const [sent, setSent] = useState<{ plan: string | null; at: string } | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);

  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    analytics.track('space_showcase_viewed', { screen_identifier: 'space_showcase' });
  }, []);

  const selected = plans.find(item => item.code === plan) ?? null;
  const name = (value: TariffPlan | null) =>
    value ? (language === 'uk' ? value.nameUk : value.nameEn) : '';

  const message = selected
    ? t('tariffMessageWant', { plan: name(selected), email })
    : t('tariffMessageWantSpace', { email });

  const requested =
    sent ??
    (request?.lastContactAt ? { plan: request.planInterest, at: request.lastContactAt } : null);
  const requestedPlan = plans.find(item => item.code === requested?.plan) ?? null;

  const contacted = (channel: TariffContactChannel) => {
    analytics.track('space_contact_clicked', {
      feature_identifier: plan ?? 'none',
      input_method: channel
    });
    setSent({ plan, at: new Date().toISOString() });
    // Recorded quietly: the message has already left through the channel the
    // person chose, and a failed note on our side is not theirs to fix.
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

  const copyEmail = async () => {
    const copied = await copyText(email);
    push({
      tone: copied ? 'success' : 'error',
      text: t(copied ? 'tariffEmailCopied' : 'tariffContactCopyFailed')
    });
  };

  const planOptions = useMemo(
    () =>
      plans.map(item => ({
        value: item.code,
        label: name(item),
        description: [
          language === 'uk' ? item.summaryUk : item.summaryEn,
          t('tariffPlanSeats', { count: item.baseSeats })
        ]
          .filter(Boolean)
          .join(' · ')
      })),
    // `name` reads `language`, which is in the list.
    [plans, language, t]
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

      <Card role="panel" className="tariff-showcase-card">
        <div className="tariff-showcase-hero">
          <img className="tariff-showcase-art" src="/workspace-banner.png" alt="" />
          <div className="flex flex-col gap-2">
            <h1 id="tariff-showcase-title" className="tariff-showcase-title">
              {t('tariffShowcaseTitle')}
            </h1>
            <p className="text-ink-muted prose">{t('tariffShowcaseLead')}</p>
          </div>
        </div>

        <ul className="tariff-feature-list">
          {FEATURES.map(feature => (
            <li key={feature.key} className="tariff-feature">
              <span className="tariff-feature-icon" aria-hidden="true">
                <feature.icon size={ICON_SIZE} strokeWidth={ICON_STROKE} />
              </span>
              <span>{t(feature.key)}</span>
            </li>
          ))}
        </ul>

        {planOptions.length > 0 && (
          <RadioGroup
            variant="cards"
            label={t('tariffShowcasePlans')}
            value={plan}
            options={planOptions}
            onChange={setPlan}
            className="tariff-plan-choice"
          />
        )}

        {requested ? (
          <div className="tariff-showcase-sent" role="status">
            <CheckCircle2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <p className="prose">
              {requestedPlan
                ? t('tariffShowcaseSent', {
                    plan: name(requestedPlan),
                    date: formatTariffMoment(requested.at, language),
                    email
                  })
                : t('tariffShowcaseSentNoPlan', {
                    date: formatTariffMoment(requested.at, language),
                    email
                  })}
            </p>
            <ContactAdminButton
              contact={showcase?.contact}
              message={message}
              subject={t('tariffMessageSubject')}
              label={t('tariffShowcaseWriteAgain')}
              color="neutral"
              variant="outline"
              onContact={contacted}
            />
          </div>
        ) : (
          <div className="tariff-showcase-action">
            <p className="tariff-showcase-email text-caption text-ink-muted">
              {t('tariffShowcaseOpensOn', { email })}
              {email && (
                <IconButton
                  label={t('tariffCopyEmail')}
                  size="sm"
                  variant="ghost"
                  onClick={() => void copyEmail()}
                >
                  <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                </IconButton>
              )}
            </p>
            <ContactAdminButton
              contact={showcase?.contact}
              message={message}
              subject={t('tariffMessageSubject')}
              onContact={contacted}
            />
          </div>
        )}
      </Card>
    </section>
  );
}
