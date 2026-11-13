import { useLaunchCopyMark } from './LaunchCopyHistory';
import { useEffect, useId, useRef, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import {
  LAUNCH_NOTE_TITLE_MAX,
  LAUNCH_NOTE_TEXT_MAX,
  launchNoteLabel,
  type LaunchNote
} from '@video-compressor/shared';
import { Accordion, Button, IconButton, Input, Textarea } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { analytics } from '../../analytics/service';

export function LaunchNotesEditor({
  notes,
  onChange,
  disabled
}: {
  notes: LaunchNote[];
  onChange: (notes: LaunchNote[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [newId, setNewId] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const patch = (id: string, patch: Partial<LaunchNote>) =>
    onChange(notes.map(note => (note.id === id ? { ...note, ...patch } : note)));
  return (
    <Accordion
      openIds={open ? new Set(['notes']) : new Set()}
      onToggle={() => setOpen(v => !v)}
      items={[
        {
          id: 'notes',
          title: t('launchesNotes'),
          content: (
            <div className="launch-notes-grid">
              {notes.map((note, index) => (
                <div key={note.id} className="launch-note-editor">
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      aria-label={t('launchesNoteTitleOf', { number: index + 1 })}
                      placeholder={t('launchesNoteTitle')}
                      value={note.title}
                      maxLength={LAUNCH_NOTE_TITLE_MAX}
                      disabled={disabled}
                      autoFocus={note.id === newId}
                      onChange={e => patch(note.id, { title: e.target.value })}
                    />
                    <IconButton
                      label={t('launchesNoteDeleteOf', { number: index + 1 })}
                      title=""
                      disabled={disabled}
                      onClick={() => {
                        onChange(notes.filter(item => item.id !== note.id));
                        requestAnimationFrame(() => addButton.current?.focus());
                      }}
                    >
                      <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                    </IconButton>
                  </div>
                  <Textarea
                    className="launch-note-text"
                    aria-label={t('launchesNoteTextOf', { number: index + 1 })}
                    placeholder={t('launchesNoteText')}
                    value={note.text}
                    maxLength={LAUNCH_NOTE_TEXT_MAX}
                    disabled={disabled}
                    onChange={e => patch(note.id, { text: e.target.value })}
                  />
                </div>
              ))}
              <Button
                ref={addButton}
                type="button"
                className="launch-note-add"
                variant="secondary"
                disabled={disabled}
                onClick={() => {
                  const id = crypto.randomUUID();
                  setNewId(id);
                  onChange([...notes, { id, title: '', text: '' }]);
                }}
              >
                <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                {t('launchesNoteAdd')}
              </Button>
            </div>
          )
        }
      ]}
    />
  );
}

function NoteCopy({ note, disabled }: { note: LaunchNote; disabled: boolean }) {
  const { t } = useI18n();
  const copiedDescriptionId = useId();
  const [flashText, setFlashText] = useState<string | null>(null);
  const copied = flashText === note.text;
  const remembered = useLaunchCopyMark(`note:${note.id}`, note.text);
  const alreadyCopied = remembered.seen && !copied;
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const current = useRef(note.text);
  current.current = note.text;
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    setFlashText(null);
    setFailed(false);
  }, [note.text]);
  const copy = async () => {
    const id = crypto.randomUUID();
    const text = note.text;
    const remember = remembered.remember;
    const signal = (event: 'operation_started' | 'operation_completed' | 'operation_failed') => {
      try {
        analytics.track(event, { flow_step: 'launch_notes_copy', flow_id: id, attempt_id: id });
      } catch {
        /* Clipboard behavior does not depend on diagnostics delivery. */
      }
    };
    setPending(true);
    setFailed(false);
    signal('operation_started');
    try {
      await navigator.clipboard.writeText(text);
      if (!remember()) return;
      signal('operation_completed');
      if (mounted.current && current.current === text) {
        setFlashText(text);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setFlashText(null), 1500);
      }
    } catch {
      signal('operation_failed');
      if (mounted.current && current.current === text) setFailed(true);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return (
    <div className="min-w-0">
      <Button
        type="button"
        className={`launch-note-copy${alreadyCopied ? ' launch-note-already-copied' : ''}`}
        aria-describedby={alreadyCopied ? copiedDescriptionId : undefined}
        color={copied ? 'success' : 'secondary'}
        variant="soft"
        disabled={disabled || pending}
        onClick={() => void copy()}
      >
        <span className="launch-note-copy-label">{launchNoteLabel(note)}</span>
        {(copied || alreadyCopied) && (
          <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        )}
      </Button>
      {alreadyCopied && (
        <span id={copiedDescriptionId} className="visually-hidden">
          {t('launchesAlreadyCopied')}
        </span>
      )}
      {copied && (
        <span className="visually-hidden" role="status">
          {t('launchesCopied')}
        </span>
      )}
      {failed && (
        <span className="field-error" role="alert">
          {t('launchesNoteCopyFailed')}
        </span>
      )}
    </div>
  );
}
export function LaunchNotesResult({ notes, disabled }: { notes: LaunchNote[]; disabled: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const visible = notes.filter(note => note.text.trim().length > 0);
  if (!visible.length) return null;
  return (
    <Accordion
      className="launch-result-notes"
      openIds={open ? new Set(['notes']) : new Set()}
      onToggle={() => setOpen(v => !v)}
      items={[
        {
          id: 'notes',
          title: t('launchesNotes'),
          content: (
            <div className="launch-notes-grid">
              {visible.map(note => (
                <NoteCopy key={note.id} note={note} disabled={disabled} />
              ))}
            </div>
          )
        }
      ]}
    />
  );
}
