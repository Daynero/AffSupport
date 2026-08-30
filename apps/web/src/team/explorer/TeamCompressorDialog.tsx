import { useId, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';

/**
 * The team compressor (013 B2): a compact window over the agent's own
 * compressor settings. Quality and the embedding images come from the
 * compressor page (cached on the agent); here the person only decides the
 * embedding on/off, the name ending, and where the results land — beside the
 * originals, in a chosen Drive folder, or overwriting the originals in place
 * (same file id, transcripts stay attached, only after a successful run).
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
    | { kind: 'local' }
    | { kind: 'overwrite' };
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
  const titleId = useId();
  const [embed, setEmbed] = useState(false);
  const [suffix, setSuffix] = useState('');
  const [mode, setMode] = useState<'beside' | 'folder' | 'local' | 'overwrite'>('beside');
  const [folder, setFolder] = useState<{ id: string | null; name: string } | null>(null);
  const [picking, setPicking] = useState(false);

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
          : { kind: mode }
    });
    onClose();
  };

  return (
    <Modal labelledBy={titleId} size="md" className="team-compress-dialog" onClose={onClose}>
      <h3 id={titleId}>{t('teamCompressTitle', { count: items.length })}</h3>
      <p className="team-explorer-muted">{t('teamCompressQualityNote')}</p>

      <label className="team-compress-row">
        <input type="checkbox" checked={embed} onChange={event => setEmbed(event.target.checked)} />
        <span>{t('teamCompressEmbed')}</span>
      </label>

      <label className="team-compress-row team-compress-suffix">
        <span>{t('outputSuffixLabel')}</span>
        <input
          type="text"
          maxLength={60}
          placeholder={t('teamCompressSuffixPlaceholder')}
          value={suffix}
          onChange={event => setSuffix(event.target.value)}
        />
      </label>

      <fieldset className="team-compress-destination">
        <legend>{t('teamCompressWhere')}</legend>
        <label>
          <input
            type="radio"
            name="team-compress-destination"
            checked={mode === 'beside'}
            onChange={() => setMode('beside')}
          />
          <span>{t('teamCompressBeside')}</span>
        </label>
        <label>
          <input
            type="radio"
            name="team-compress-destination"
            checked={mode === 'folder'}
            onChange={() => {
              setMode('folder');
              if (!folder) setPicking(true);
            }}
          />
          <span>
            {t('teamCompressToFolder')}
            {mode === 'folder' && folder ? ` — ${folder.name}` : ''}
          </span>
          {mode === 'folder' && (
            <Button type="button" variant="ghost" onClick={() => setPicking(true)}>
              {t('teamFileMove')}…
            </Button>
          )}
        </label>
        <label>
          <input
            type="radio"
            name="team-compress-destination"
            checked={mode === 'local'}
            onChange={() => setMode('local')}
          />
          <span>{t('teamCompressLocal')}</span>
        </label>
        <label>
          <input
            type="radio"
            name="team-compress-destination"
            checked={mode === 'overwrite'}
            onChange={() => setMode('overwrite')}
          />
          <span>{t('teamCompressOverwrite')}</span>
        </label>
        {mode === 'overwrite' && (
          <p className="team-explorer-muted">{t('teamCompressOverwriteHint')}</p>
        )}
      </fieldset>

      <div className="team-dialog-actions">
        <Button
          type="button"
          variant="primary"
          disabled={items.length === 0 || (mode === 'folder' && !folder)}
          onClick={run}
        >
          {t('teamCompressStart', { count: items.length })}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
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
