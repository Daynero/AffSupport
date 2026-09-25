import { useId } from 'react';
import { useI18n } from '../../i18n';
import { Modal } from '../../components/Modal';
import { SpaceSettings, type SpaceSettingsClient } from './SpaceSettings';
import type { TeamSettingsTab } from '../routes';
import type { StorageHealth } from '@video-compressor/shared';

/**
 * Space settings as a dialog over the explorer (011, FR-029): the same panels
 * as before, reached from the header rather than as a fourth destination. The
 * address carries `settings=1`, so a link to it still works and Back closes it.
 */
export function SettingsDialog({
  teamId,
  client,
  health,
  initialTab,
  onTabChange,
  onClose
}: {
  teamId: string;
  client: SpaceSettingsClient;
  health?: StorageHealth | null;
  initialTab?: TeamSettingsTab | null;
  onTabChange?: (tab: TeamSettingsTab) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} size="xl" onClose={onClose} className="team-settings-dialog">
      <span id={titleId} className="visually-hidden">
        {t('teamSpaceSettings')}
      </span>
      <SpaceSettings
        teamId={teamId}
        client={client}
        health={health}
        initialTab={initialTab}
        onTabChange={onTabChange}
        onBack={onClose}
      />
    </Modal>
  );
}
