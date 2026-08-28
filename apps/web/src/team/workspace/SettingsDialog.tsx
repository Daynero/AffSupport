import { useId } from 'react';
import { Modal } from '../../components/Modal';
import { SpaceSettings, type SpaceSettingsClient } from './SpaceSettings';

/**
 * Space settings as a dialog over the explorer (011, FR-029): the same panels
 * as before, reached from the header rather than as a fourth destination. The
 * address carries `settings=1`, so a link to it still works and Back closes it.
 */
export function SettingsDialog({
  teamId,
  client,
  directAddMode = 'disabled',
  onClose
}: {
  teamId: string;
  client: SpaceSettingsClient;
  directAddMode?: 'disabled' | 'testing';
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} size="xl" onClose={onClose} className="team-settings-dialog">
      <span id={titleId} className="visually-hidden">
        Settings
      </span>
      <SpaceSettings
        teamId={teamId}
        client={client}
        directAddMode={directAddMode}
        onBack={onClose}
      />
    </Modal>
  );
}
