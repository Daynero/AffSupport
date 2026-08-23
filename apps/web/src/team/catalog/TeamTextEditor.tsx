import { useMemo, useState } from 'react';
import type { CatalogMaterialItem } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessage } from '../errors';

const MAX_TEXT_BYTES = 1024 * 1024;

export interface TeamTextSaveInput {
  text: string;
  expectedDriveVersion: string;
  expectedChecksum?: string;
  idempotencyKey: string;
}

export function TeamTextEditor({
  material,
  initialText,
  expectedDriveVersion,
  expectedChecksum,
  onSave,
  onReload,
  onCreateVersion,
  onClose
}: {
  material: CatalogMaterialItem;
  initialText: string;
  expectedDriveVersion: string;
  expectedChecksum?: string | null;
  onSave: (input: TeamTextSaveInput) => Promise<unknown>;
  onReload: () => void | Promise<void>;
  onCreateVersion: (text: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const bytes = useMemo(() => new TextEncoder().encode(text).byteLength, [text]);
  const eligible =
    material.fileExtension?.toLowerCase() === 'txt' &&
    material.mimeType?.split(';', 1)[0].trim().toLowerCase() === 'text/plain';

  const save = async () => {
    if (!eligible || bytes > MAX_TEXT_BYTES) return;
    setSaving(true);
    setStale(false);
    try {
      await onSave({
        text,
        expectedDriveVersion,
        ...(expectedChecksum ? { expectedChecksum } : {}),
        idempotencyKey: crypto.randomUUID()
      });
      push({ tone: 'success', text: t('teamToastTextSaved') });
      onClose();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'PROCESS_FAILED';
      // A stale source is a decision to offer, not a dead end: the editor keeps
      // the text and explains. Everything else is announced and the draft stays.
      if (code === 'SOURCE_CHANGED') setStale(true);
      else push({ tone: 'error', text: teamErrorMessage(code, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="team-text-editor" aria-labelledby="team-text-editor-title">
      <div className="team-panel-heading">
        <div>
          <p className="team-workspace-eyebrow">{t('teamTextEditorEyebrow')}</p>
          <h3 id="team-text-editor-title">{material.name}</h3>
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamFileCancel')}
        </Button>
      </div>
      {!eligible ? (
        <p className="team-inline-error">{t('teamTextEditorTxtOnly')}</p>
      ) : (
        <>
          <label>
            {t('teamTextEditorContents')}
            <textarea
              aria-label={t('teamTextEditorContents')}
              value={text}
              onChange={event => setText(event.target.value)}
              rows={14}
              spellCheck
            />
          </label>
          <small className={bytes > MAX_TEXT_BYTES ? 'team-inline-error' : ''}>
            {t('teamTextEditorBytes', { count: bytes })}
          </small>
          {bytes > MAX_TEXT_BYTES && <p>{t('teamTextEditorTooLarge')}</p>}
          {stale && (
            <div className="team-text-stale" role="alert">
              <p>{t('teamTextEditorStale')}</p>
              <Button type="button" onClick={() => void onReload()}>
                {t('teamTextEditorReload')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => void onCreateVersion(text)}>
                {t('teamTextEditorSeparateVersion')}
              </Button>
            </div>
          )}
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="primary"
              loading={saving}
              disabled={bytes > MAX_TEXT_BYTES}
              onClick={() => void save()}
            >
              {t('teamTextEditorSave')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
