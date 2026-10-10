import { useId, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button, Checkbox, FormField, Input, RadioGroup } from '../../components/ui/index';
import type { RadioOption } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { useOptionalAgent } from '../../AgentContext';
import { localCompressSupported } from '../../api/client';
import { compactPath } from '../../format';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import type { AgentQueueItem } from './useAgentQueue';

/**
 * The team compressor (013 B2): a compact window over the agent's own
 * compressor settings. Quality and the embedding images come from the
 * compressor page (cached on the agent); here the person only decides the
 * embedding on/off, the name ending, and where the results land — beside the
 * originals, in a chosen Drive folder, overwriting the originals in place
 * (same file id, transcripts stay attached, only after a successful run), or
 * on this computer only (B5: nothing is written to the space).
 */
export interface CompressPlanItem {
  id: string;
  name: string;
  folderId: string | null;
}

export interface CompressPlan {
  items: CompressPlanItem[];
  embed: boolean;
  suffix: string;
  destination:
    | { kind: 'beside' }
    | { kind: 'folder'; folderId: string | null; folderName: string }
    /** The folder on this computer; null asks once, as the first file starts. */
    | { kind: 'local'; folder: string | null }
    | { kind: 'overwrite' };
}

/** Where this member's locally saved compressions land, per space, in their own browser. */
function localFolderKey(teamId: string): string {
  return `wishly.team-compress-folder.v1:${teamId}`;
}

export function rememberedLocalFolder(teamId: string): string | null {
  try {
    return localStorage.getItem(localFolderKey(teamId));
  } catch {
    // A browser that refuses storage asks for the folder once per batch instead.
    return null;
  }
}

export function rememberLocalFolder(teamId: string, folder: string): void {
  try {
    localStorage.setItem(localFolderKey(teamId), folder);
  } catch {
    // Remembering is a convenience; the next batch simply asks again.
  }
}

/**
 * The queue jobs a plan asks for (024): one per file, named as the plan says.
 *
 * Out of `ExplorerShell` so a task attachment can compress too — the same
 * dialog, the same names, the same queue — and carry the task its result
 * belongs on.
 */
export function compressJobs(plan: CompressPlan, attachTo?: { taskId: string }): AgentQueueItem[] {
  const suffix = plan.suffix;
  return plan.items.map(item => {
    const stem = item.name.replace(/\.[^.]+$/u, '');
    const overwrite = plan.destination.kind === 'overwrite';
    const outputName = overwrite
      ? suffix
        ? `${stem}${suffix}.mp4`
        : item.name
      : `${stem}${suffix || '_1'}.mp4`;
    return {
      id: item.id,
      name: item.name,
      folderId: plan.destination.kind === 'folder' ? plan.destination.folderId : item.folderId,
      tool: 'compressor' as const,
      outputName,
      ...(overwrite ? { versionOf: item.id } : {}),
      ...(plan.destination.kind === 'local'
        ? { local: { embed: plan.embed, suffix, folder: plan.destination.folder } }
        : {}),
      options: plan.embed ? { imageEmbedding: { enabled: true } } : {},
      ...(attachTo ? { attachTo } : {})
    };
  });
}

export function TeamCompressorDialog({
  teamId,
  items,
  client,
  onRun,
  onClose
}: {
  teamId: string;
  items: CompressPlanItem[];
  client: FolderPickerClient;
  onRun: (plan: CompressPlan) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const titleId = useId();
  const [embed, setEmbed] = useState(false);
  const [suffix, setSuffix] = useState('');
  const [mode, setMode] = useState<'beside' | 'folder' | 'local' | 'overwrite'>('beside');
  const [folder, setFolder] = useState<{ id: string | null; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const suffixId = useId();
  /*
   * The local folder: the one this space last saved into, else the compressor's own chosen
   * folder (its "Separate folder" setting) — the place this person already told Soty that
   * compressed videos go. Neither: the app asks once, as the first file starts, and the
   * rest of the batch follows it there.
   */
  const [localFolder, setLocalFolder] = useState<string | null>(() => {
    const settings = agent?.state.settings;
    return (
      rememberedLocalFolder(teamId) ??
      (settings?.outputMode === 'chosen-folder' ? settings.outputFolder : null)
    );
  });
  // Only an app that answered and is too old is refused here; an unknown one is tried, and
  // the run says what it found.
  const contracts = agent?.toolContracts ?? {};
  const localTooOld = Object.keys(contracts).length > 0 && !localCompressSupported(contracts);

  type Destination = 'beside' | 'folder' | 'local' | 'overwrite';
  const destinations: ReadonlyArray<RadioOption<Destination>> = [
    { value: 'beside', label: t('teamCompressBeside') },
    {
      value: 'folder',
      label: t('teamCompressToFolder'),
      description: mode === 'folder' && folder ? folder.name : undefined
    },
    {
      value: 'local',
      label: t('teamCompressLocal'),
      disabled: localTooOld,
      description: localTooOld ? (
        t('teamCompressLocalTooOld')
      ) : mode !== 'local' ? undefined : localFolder ? (
        <span title={localFolder}>{compactPath(localFolder)}</span>
      ) : (
        t('teamCompressLocalAsk')
      )
    },
    {
      value: 'overwrite',
      label: t('teamCompressOverwrite'),
      description: mode === 'overwrite' ? t('teamCompressOverwriteHint') : undefined
    }
  ];

  const run = () => {
    onRun({
      items,
      embed,
      suffix: suffix.trim(),
      destination:
        mode === 'folder'
          ? {
              kind: 'folder',
              folderId: folder?.id === 'root' ? null : (folder?.id ?? null),
              folderName: folder?.name ?? t('teamFolderPickerRoot')
            }
          : mode === 'local'
            ? { kind: 'local', folder: localFolder }
            : { kind: mode }
    });
    onClose();
  };

  return (
    <Modal
      labelledBy={titleId}
      size="md"
      className="team-compress-dialog"
      onClose={onClose}
      closeLabel={t('teamClose')}
    >
      <h3 id={titleId}>{t('teamCompressTitle', { count: items.length })}</h3>
      <p className="team-explorer-muted">{t('teamCompressQualityNote')}</p>

      <Checkbox label={t('teamCompressEmbed')} checked={embed} onChange={setEmbed} />

      <FormField label={t('outputSuffixLabel')} htmlFor={suffixId} className="team-compress-suffix">
        <Input
          id={suffixId}
          maxLength={60}
          placeholder={t('teamCompressSuffixPlaceholder')}
          value={suffix}
          onChange={event => setSuffix(event.target.value)}
        />
      </FormField>

      <div className="team-compress-destination">
        {/* The group names itself to assistive tech; this is the same name,
            on screen, at the label step. */}
        <span className="ui-field-label">{t('teamCompressWhere')}</span>
        <RadioGroup
          label={t('teamCompressWhere')}
          value={mode}
          options={destinations}
          onChange={next => {
            setMode(next);
            if (next === 'folder' && !folder) setPicking(true);
          }}
        />
        {/* Outside the group: a control inside a radio's own label would fire
            the radio on its way to the button. */}
        {mode === 'folder' && (
          <Button color="neutral" variant="ghost" size="sm" onClick={() => setPicking(true)}>
            {t('teamFileMove')}…
          </Button>
        )}
        {/* Clearing the folder is how another one is chosen: the app's own picker opens when
            the first file starts, which is the only picker that hands back a real path. */}
        {mode === 'local' && localFolder && (
          <Button color="neutral" variant="ghost" size="sm" onClick={() => setLocalFolder(null)}>
            {t('teamCompressLocalChange')}
          </Button>
        )}
      </div>

      <div className="team-dialog-actions">
        <Button
          color="primary"
          variant="solid"
          disabled={items.length === 0 || (mode === 'folder' && !folder)}
          onClick={run}
        >
          {t('teamCompressStart', { count: items.length })}
        </Button>
        <Button color="neutral" variant="ghost" onClick={onClose}>
          {t('teamCancel')}
        </Button>
      </div>

      {picking && (
        <FolderPicker
          teamId={teamId}
          client={client}
          title={t('teamCompressToFolder')}
          onClose={() => setPicking(false)}
          onSelect={next => {
            setFolder({ id: next.id, name: next.name });
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}
