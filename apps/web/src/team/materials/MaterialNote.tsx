import { useEffect, useRef, useState } from 'react';
import { PencilLine, Plus } from 'lucide-react';
import { MATERIAL_NOTE_MAX } from '@video-compressor/shared';
import { Button, IconButton, Modal, Textarea } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { saveMaterialNote, useMaterialNote, type MaterialNoteClient } from './materialNotes';

/**
 * A note on a file (024): a few words a person leaves for the next one — what the video was made
 * for, which account it ran on, what to fix before it goes out again.
 *
 * It is Soty's, not Drive's: nothing is written to the file, so its version does not move and a
 * download carries no trace of it. The card shows it where the file is described; editing happens
 * in place, the way a comment is edited in Linear, and the same editor opens from any menu.
 */

/** Past this many characters the card shows the start and a "Show all". */
const FOLDED_AT = 280;

export function MaterialNoteEditor({
  teamId,
  materialId,
  initial,
  client,
  onDone
}: {
  teamId: string;
  materialId: string;
  initial: string;
  client?: MaterialNoteClient;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const field = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const tooLong = draft.trim().length > MATERIAL_NOTE_MAX;
  const unchanged = draft.trim() === initial.trim();

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const save = async () => {
    if (busy || tooLong) return;
    if (unchanged) {
      onDone();
      return;
    }
    setBusy(true);
    try {
      const saved = await saveMaterialNote(teamId, materialId, draft, client);
      push({ tone: 'success', text: t(saved ? 'materialNoteSaved' : 'materialNoteRemoved') });
      onDone();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      setBusy(false);
    }
  };

  return (
    <form
      className="team-material-note-editor"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <Textarea
        ref={field}
        size="sm"
        rows={4}
        value={draft}
        invalid={tooLong}
        disabled={busy}
        aria-label={t('materialNoteTitle')}
        placeholder={t('materialNotePlaceholder')}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
      />
      <div className="team-material-note-editor-bar">
        <span className={tooLong ? 'team-material-note-count is-over' : 'team-material-note-count'}>
          {draft.trim().length > MATERIAL_NOTE_MAX * 0.8
            ? `${draft.trim().length} / ${MATERIAL_NOTE_MAX}`
            : t('materialNoteSaveHint')}
        </span>
        <Button type="button" size="sm" color="neutral" variant="ghost" onClick={onDone}>
          {t('teamCancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          color="primary"
          variant="solid"
          loading={busy}
          disabled={tooLong}
        >
          {t('materialNoteSave')}
        </Button>
      </div>
    </form>
  );
}

function NoteText({ note }: { note: string }) {
  const { t } = useI18n();
  const [whole, setWhole] = useState(false);
  const folds = note.length > FOLDED_AT;
  return (
    <>
      <p className="team-material-note-text">
        {folds && !whole ? `${note.slice(0, FOLDED_AT).trimEnd()}…` : note}
      </p>
      {folds && (
        <button
          type="button"
          className="team-material-note-more"
          onClick={() => setWhole(current => !current)}
        >
          {t(whole ? 'materialNoteShowLess' : 'materialNoteShowAll')}
        </button>
      )}
    </>
  );
}

/** The note in a file's details card: read at a glance, edited in place. */
export function MaterialNoteBlock({
  teamId,
  materialId,
  canEdit,
  revision,
  client
}: {
  teamId: string;
  materialId: string;
  canEdit: boolean;
  revision?: number;
  client?: MaterialNoteClient;
}) {
  const { t } = useI18n();
  const entry = useMaterialNote(teamId, materialId, { revision, client });
  const [editing, setEditing] = useState(false);

  useEffect(() => setEditing(false), [materialId]);

  if (entry.state !== 'ready') return null;
  const note = entry.note;

  if (editing) {
    return (
      <section className="team-material-note is-editing" aria-label={t('materialNoteTitle')}>
        <MaterialNoteEditor
          teamId={teamId}
          materialId={materialId}
          initial={note ?? ''}
          client={client}
          onDone={() => setEditing(false)}
        />
      </section>
    );
  }

  if (!note) {
    if (!canEdit) return null;
    return (
      <Button
        type="button"
        size="sm"
        color="neutral"
        variant="ghost"
        className="team-material-note-add"
        onClick={() => setEditing(true)}
      >
        <Plus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('materialNoteAdd')}
      </Button>
    );
  }

  return (
    <section className="team-material-note" aria-label={t('materialNoteTitle')}>
      <header className="team-material-note-head">
        <span>{t('materialNoteTitle')}</span>
        {canEdit && (
          <IconButton
            size="xs"
            variant="ghost"
            label={t('materialNoteEdit')}
            onClick={() => setEditing(true)}
          >
            <PencilLine aria-hidden="true" />
          </IconButton>
        )}
      </header>
      <NoteText key={note} note={note} />
    </section>
  );
}

/** The same note, opened from a menu: a row, a search result, a task's attachment. */
export function MaterialNoteDialog({
  teamId,
  materialId,
  name,
  canEdit,
  client,
  onClose
}: {
  teamId: string;
  materialId: string;
  name: string;
  canEdit: boolean;
  client?: MaterialNoteClient;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const entry = useMaterialNote(teamId, materialId, { client });

  return (
    <Modal nested size="sm" title={t('materialNoteDialogTitle', { name })} onClose={onClose}>
      <div className="team-material-note-dialog">
        {entry.state === 'loading' && (
          <p className="team-material-note-quiet">{t('teamPreviewLoading')}</p>
        )}
        {entry.state === 'failed' && <p className="soty-field-error">{t('materialNoteFailed')}</p>}
        {entry.state === 'ready' &&
          (canEdit ? (
            <MaterialNoteEditor
              teamId={teamId}
              materialId={materialId}
              initial={entry.note ?? ''}
              client={client}
              onDone={onClose}
            />
          ) : entry.note ? (
            <NoteText note={entry.note} />
          ) : (
            <p className="team-material-note-quiet">{t('materialNoteEmpty')}</p>
          ))}
      </div>
    </Modal>
  );
}
