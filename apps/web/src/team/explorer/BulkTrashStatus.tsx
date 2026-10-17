import type { TeamBulkTrashItem } from '@video-compressor/shared';
import { Chip } from '../../components/ui';
import { useI18n } from '../../i18n';

export function BulkTrashStatus({ state }: { state: TeamBulkTrashItem['state'] }) {
  const { t } = useI18n();
  const color =
    state === 'confirmed'
      ? 'success'
      : state === 'failed' || state === 'unknown'
        ? 'warning'
        : 'neutral';
  const label = {
    queued: 'teamBulkTrashQueued',
    active: 'teamBulkTrashActive',
    confirmed: 'teamBulkTrashConfirmed',
    failed: 'teamBulkTrashFailed',
    unknown: 'teamBulkTrashUnknown'
  } as const;
  return (
    <Chip size="xs" color={color} variant="soft" role="status">
      {t(label[state])}
    </Chip>
  );
}
