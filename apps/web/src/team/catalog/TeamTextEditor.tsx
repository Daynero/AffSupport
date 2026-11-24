import { useMemo, useState } from 'react';
import type { CatalogMaterialItem } from '@video-compressor/shared';
import { Button, ConfirmDialog, FormField, Textarea } from '../../components/ui/index';
import { Modal } from '../../components/Modal';
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
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  /**
   * Escape and the close control go through here, so an edited draft is never
   * thrown away by a stray keypress. An untouched editor just closes — a prompt
   * with nothing to lose is noise.
   */
  const requestClose = () => {
    if (text === initialText) onClose();
    else setConfirmingDiscard(true);
  };
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
    <Modal
      labelledBy="team-text-editor-title"
      size="lg"
      className="team-text-editor"
      // Straight into the text: this dialog exists to be typed in.
      initialFocus="#team-text-editor-body"
      onClose={requestClose}
      closeLabel={t('teamClose')}
    >
      <div>
        <p className="team-workspace-eyebrow">{t('teamTextEditorEyebrow')}</p>
        <h2 id="team-text-editor-title">{material.name}</h2>
      </div>
      {!eligible ? (
        <p className="team-inline-error" role="alert">
          {t('teamTextEditorTxtOnly')}
        </p>
      ) : (
        <>
          {/* The count of bytes is the field's help, and turns into its error past the limit. */}
          <FormField
            label={t('teamTextEditorContents')}
            htmlFor="team-text-editor-body"
            help={t('teamTextEditorBytes', { count: bytes })}
            error={
              bytes > MAX_TEXT_BYTES
                ? `${t('teamTextEditorBytes', { count: bytes })} · ${t('teamTextEditorTooLarge')}`
                : undefined
            }
          >
            <Textarea
              id="team-text-editor-body"
              value={text}
              onChange={event => setText(event.target.value)}
              rows={14}
              spellCheck
              invalid={bytes > MAX_TEXT_BYTES}
            />
          </FormField>
          {stale && (
            <div className="team-text-stale" role="alert">
              <p>{t('teamTextEditorStale')}</p>
              <Button variant="secondary" onClick={() => void onReload()}>
                {t('teamTextEditorReload')}
              </Button>
              <Button variant="secondary" onClick={() => void onCreateVersion(text)}>
                {t('teamTextEditorSeparateVersion')}
              </Button>
            </div>
          )}
          <div className="team-dialog-actions">
            <Button variant="ghost" onClick={requestClose}>
              {t('teamCancel')}
            </Button>
            <Button
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
      {confirmingDiscard && (
        <ConfirmDialog
          nested
          title={t('teamTextEditorDiscardTitle')}
          body={t('teamTextEditorDiscardBody')}
          confirmLabel={t('teamTextEditorDiscardAction')}
          cancelLabel={t('teamCancel')}
          initialFocus="cancel"
          onCancel={() => setConfirmingDiscard(false)}
          onConfirm={onClose}
        />
      )}
    </Modal>
  );
}
