import { useEffect, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import type { TeamTariff } from '@video-compressor/shared';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Badge } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { SettingsSection } from '../workspace/SettingsSection';
import { ContactAdminButton } from './ContactAdminButton';
import { formatTariffDay, planName } from './format';
import { useOptionalSpaceAccess } from './useSpaceAccess';

/**
 * «Тариф» in the space's settings (034, US4.3), for the owner.
 *
 * Three facts and one way to change them: the plan and the last day it runs,
 * the seats counted with the owner, and a line to the administrator. Only for
 * a space that is on a running plan — one the old rule or an administrator
 * holds open has nothing here to say (US2), so the section is not drawn.
 */
export function SpaceTariffSection({
  teamId,
  spaceName,
  client
}: {
  teamId: string;
  spaceName: string;
  client: { getTeamTariff?: (teamId: string) => Promise<TeamTariff> };
}) {
  const { t, language } = useI18n();
  const auth = useOptionalAuth();
  const spaceAccess = useOptionalSpaceAccess();
  const [tariff, setTariff] = useState<TeamTariff | null>(null);

  useEffect(() => {
    if (!client.getTeamTariff) return;
    let active = true;
    void client
      .getTeamTariff(teamId)
      .then(value => {
        if (active) setTariff(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, teamId]);

  if (
    !tariff ||
    !tariff.planCode ||
    !(tariff.state === 'active' || tariff.state === 'expiring' || tariff.state === 'grace')
  ) {
    return null;
  }

  const plan = planName(tariff, language);
  const email = spaceAccess?.access?.showcase?.email || auth?.user?.email || '';

  return (
    <SettingsSection
      icon={BadgeCheck}
      titleId="team-tariff-title"
      title={t('tariffSettingsTitle')}
      aside={
        tariff.state === 'grace' ? (
          <Badge color="error" variant="soft">
            {t('tariffStateGrace')}
          </Badge>
        ) : tariff.state === 'expiring' ? (
          <Badge color="warning" variant="soft">
            {t('tariffStateExpiring')}
          </Badge>
        ) : undefined
      }
      className="tariff-settings"
    >
      <div className="flex flex-col gap-2">
        <p>
          {tariff.endsOn
            ? t('tariffSettingsPlanUntil', {
                plan,
                date: formatTariffDay(tariff.endsOn, language)
              })
            : plan}
        </p>
        <p className="text-ink-muted">
          {t('tariffSettingsSeats', { used: tariff.seatsUsed, total: tariff.seatsTotal })}
        </p>
        <div>
          <ContactAdminButton
            contact={spaceAccess?.access?.showcase?.contact}
            variant="link"
            color="secondary"
            size="sm"
            icon={false}
            label={t('tariffSettingsContact')}
            subject={t('tariffMessageSubject')}
            message={t('tariffMessageRenewOrSeats', { plan, space: spaceName, email })}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
