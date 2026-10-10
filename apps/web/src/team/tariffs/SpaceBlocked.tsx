import { useState } from 'react';
import { BellRing, FolderOpen, PauseCircle } from 'lucide-react';
import type {
  AdminContact,
  SpaceAccessTeam,
  SpaceOwnerNudgeResult
} from '@video-compressor/shared';
import { useToasts } from '../../components/toast';
import { Button, Card, Link } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { ContactAdminButton } from './ContactAdminButton';
import { formatTariffDay, formatTariffMoment, planName } from './format';

/**
 * A paused space (034, US6.2).
 *
 * Never "you were removed": the membership is intact, the files are on the
 * owner's Drive, and the same address opens the same space the moment the plan
 * is renewed — this screen is drawn *at* that address and replaced by the space
 * when the next poll says so.
 *
 * The owner can do something about it — write to the administrator. A member
 * cannot, so the one thing they are offered is to remind the owner, at most
 * once a day (the server keeps the count, and says when the next one is
 * allowed).
 */

export interface SpaceBlockedClient {
  requestOwnerNudge: (teamId: string) => Promise<SpaceOwnerNudgeResult>;
}

export function SpaceBlocked({
  team,
  contact,
  email,
  driveFolderUrl = null,
  client
}: {
  team: SpaceAccessTeam;
  contact: AdminContact | null | undefined;
  email: string;
  /** The space's Drive folder, when the page knows it; the button is left out otherwise. */
  driveFolderUrl?: string | null;
  client: SpaceBlockedClient;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const owner = team.role === 'owner' || team.tariff.isOwner;
  const [nudging, setNudging] = useState(false);
  const [nudge, setNudge] = useState<SpaceOwnerNudgeResult | null>(null);
  const plan = planName(team.tariff, language);
  const ended = formatTariffDay(team.tariff.endsOn, language);

  const remind = async () => {
    setNudging(true);
    try {
      setNudge(await client.requestOwnerNudge(team.teamId));
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setNudging(false);
    }
  };

  const nudgeNote = nudge
    ? nudge.sent
      ? t('tariffNudgeSent')
      : nudge.nextAllowedAt
        ? t('tariffNudgeLater', { date: formatTariffMoment(nudge.nextAllowedAt, language) })
        : t('tariffNudgeAlready')
    : null;

  return (
    <section
      className="tariff-page tariff-blocked"
      aria-labelledby={`tariff-blocked-${team.teamId}`}
    >
      <Card
        role="panel"
        className="tariff-blocked-card"
        icon={<PauseCircle size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        titleId={`tariff-blocked-${team.teamId}`}
        title={
          owner ? t('tariffBlockedOwnerTitle') : t('tariffBlockedMemberTitle', { space: team.name })
        }
      >
        <p className="prose">
          {owner
            ? ended
              ? t('tariffBlockedOwnerBody', { date: ended })
              : t('tariffBlockedOwnerBodyNoDate')
            : team.ownerName
              ? t('tariffBlockedMemberBody', { owner: team.ownerName })
              : t('tariffBlockedMemberBodyNoOwner')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {owner ? (
            <>
              <ContactAdminButton
                contact={contact}
                message={
                  plan
                    ? t('tariffMessageRenew', { plan, email })
                    : t('tariffMessageWantSpace', { email })
                }
                subject={t('tariffMessageSubject')}
              />
              {driveFolderUrl && (
                <Link
                  variant="standalone"
                  href={driveFolderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  leading={<FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
                >
                  {t('tariffBlockedOpenDrive')}
                </Link>
              )}
            </>
          ) : (
            <Button
              color="primary"
              loading={nudging}
              disabled={nudge !== null}
              leading={<BellRing size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              onClick={() => void remind()}
            >
              {t('tariffBlockedNudge')}
            </Button>
          )}
        </div>
        {nudgeNote && (
          <p className="text-caption text-ink-muted" role="status">
            {nudgeNote}
          </p>
        )}
      </Card>
    </section>
  );
}
