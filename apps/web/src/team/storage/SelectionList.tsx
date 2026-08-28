import { useEffect, useState } from 'react';
import type { TeamDriveSelection } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { openFolderPicker, pickerConfig, type PickFolders } from './loadPicker';

/**
 * The picked folders of a space (011, research R1 outcome B). Under outcome A
 * the root is the only selection and this list is not shown at all; the switch
 * is `VITE_TEAM_SELECTION_MODE=multi`, removed or documented by T086.
 */
export interface SelectionListClient {
  listDriveSelections: (teamId: string) => Promise<TeamDriveSelection[]>;
  addDriveSelection: (
    teamId: string,
    input: { driveFolderId: string; resourceKey: string | null; name: string }
  ) => Promise<TeamDriveSelection>;
  removeDriveSelection: (teamId: string, selectionId: string) => Promise<void>;
  pickerToken: (teamId: string) => Promise<{ accessToken: string; expiresAt: string }>;
  pickFolders?: PickFolders;
}

export function selectionModeEnabled(
  env: Record<string, string | boolean | undefined> = import.meta.env
): boolean {
  const raw = env.VITE_TEAM_SELECTION_MODE;
  return typeof raw === 'string' && raw.trim() === 'multi';
}

export function SelectionList({
  teamId,
  client,
  canManage,
  revision = 0,
  config = pickerConfig()
}: {
  teamId: string;
  client: SelectionListClient;
  canManage: boolean;
  revision?: number;
  config?: ReturnType<typeof pickerConfig>;
}) {
  const pickFolders = client.pickFolders ?? openFolderPicker;
  const { t } = useI18n();
  const { push } = useToasts();
  const [selections, setSelections] = useState<TeamDriveSelection[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .listDriveSelections(teamId)
      .then(value => {
        if (active) setSelections(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, revision, teamId]);

  const add = async () => {
    if (!config && !client.pickFolders) return;
    setBusy(true);
    try {
      const token = await client.pickerToken(teamId);
      const picked = await pickFolders({
        accessToken: token.accessToken,
        config,
        title: t('teamSelectionsAdd'),
        multiple: true
      });
      for (const folder of picked ?? []) {
        const added = await client.addDriveSelection(teamId, {
          driveFolderId: folder.id,
          resourceKey: folder.resourceKey,
          name: folder.name
        });
        setSelections(current => [...current.filter(item => item.id !== added.id), added]);
      }
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (selection: TeamDriveSelection) => {
    try {
      await client.removeDriveSelection(teamId, selection.id);
      setSelections(current => current.filter(item => item.id !== selection.id));
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
  };

  return (
    <div className="team-selection-list">
      <h3>{t('teamSelectionsTitle')}</h3>
      <ul>
        {selections.map(selection => (
          <li key={selection.id}>
            <span>
              {selection.name}
              {selection.isRoot && <small> · {t('teamSelectionsRootLabel')}</small>}
              {selection.state === 'missing' && <small> · {t('teamDriveRootMissing')}</small>}
            </span>
            {canManage && !selection.isRoot && (
              <Button type="button" variant="ghost" onClick={() => void remove(selection)}>
                {t('teamSelectionsRemove')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <Button type="button" variant="secondary" loading={busy} onClick={() => void add()}>
          {t('teamSelectionsAdd')}
        </Button>
      )}
    </div>
  );
}
