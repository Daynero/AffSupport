import type { AdminLegacySpace } from '@video-compressor/shared';
import {
  Button,
  EmptyState,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Switch,
  User
} from '../../components/ui/index';
import { useI18n } from '../../i18n';

/**
 * Spaces held open only by the old rule (034, US2.3) — the list to empty
 * before the rule is switched off. Each row grants its owner a tariff on that
 * very space, which is the whole migration, one press per space.
 */
export function TariffLegacySpaces({
  spaces,
  onGrant,
  pilot,
  pilotBusy,
  onPilot
}: {
  spaces: readonly AdminLegacySpace[];
  onGrant: (space: AdminLegacySpace) => void;
  /** 064: the assistant pilot, switched here as on a tariffed space's row. */
  pilot?: ReadonlyMap<string, boolean>;
  pilotBusy?: boolean;
  onPilot?: (teamId: string, enabled: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-2" aria-labelledby="admin-legacy-spaces">
      <h3 id="admin-legacy-spaces" className="admin-tariff-subtitle">
        {t('adminTariffLegacyTitle', { count: spaces.length })}
      </h3>
      {spaces.length === 0 ? (
        <EmptyState size="sm" className="admin-empty" title={t('adminTariffLegacyEmpty')} />
      ) : (
        <Table
          size="sm"
          className="admin-table admin-tariff-table"
          columns="minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1fr) minmax(5rem, 0.8fr) minmax(0, 1fr)"
          label={t('adminTariffLegacyTitle', { count: spaces.length })}
        >
          <TableHeader>
            <TableHeaderCell>{t('adminTariffSpace')}</TableHeaderCell>
            <TableHeaderCell>{t('adminTariffOwner')}</TableHeaderCell>
            <TableHeaderCell>{t('adminTariffPeople')}</TableHeaderCell>
            <TableHeaderCell>{t('adminTariffAssistant')}</TableHeaderCell>
            <TableHeaderCell>
              <span className="visually-hidden">{t('adminTariffActions')}</span>
            </TableHeaderCell>
          </TableHeader>
          {spaces.map(space => (
            <TableRow key={space.teamId}>
              <TableCell>{space.name}</TableCell>
              <TableCell>
                <User name={space.ownerEmail ?? '—'} meta={space.ownerName ?? undefined} />
              </TableCell>
              <TableCell>{space.membersUsed}</TableCell>
              <TableCell>
                {pilot && onPilot ? (
                  <Switch
                    checked={pilot.get(space.teamId) ?? false}
                    disabled={pilotBusy}
                    aria-label={t('adminTariffAssistantFor', { space: space.name })}
                    onChange={enabled => onPilot(space.teamId, enabled)}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell>
                <span className="flex justify-end">
                  <Button
                    size="sm"
                    color="neutral"
                    variant="outline"
                    disabled={!space.ownerEmail}
                    title={space.ownerEmail ? undefined : t('adminTariffLegacyNoOwner')}
                    onClick={() => onGrant(space)}
                  >
                    {t('adminTariffGrant')}
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </section>
  );
}
