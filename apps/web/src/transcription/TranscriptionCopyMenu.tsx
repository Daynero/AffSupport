import { useEffect, useId, useRef, useState } from 'react';
import { Button, type Translate } from '../components/ui';
import type { TranscriptionCopyContent, TranscriptionCopyScope } from './copy';

/**
 * Split control for the batch clipboard: the button copies straight away with
 * the current choices — its label always spells them out — while the chevron
 * opens the scope/content options next to it.
 */
export function TranscriptionCopyMenu({
  scope,
  content,
  finishedCount,
  selectedCount,
  busy,
  disabled,
  onScopeChange,
  onContentChange,
  onCopy,
  t
}: {
  scope: TranscriptionCopyScope;
  content: TranscriptionCopyContent;
  finishedCount: number;
  selectedCount: number;
  busy: boolean;
  disabled: boolean;
  onScopeChange: (scope: TranscriptionCopyScope) => void;
  onContentChange: (content: TranscriptionCopyContent) => void;
  onCopy: () => void;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const group = useId();
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  const scopes: { value: TranscriptionCopyScope; label: string }[] = [
    { value: 'finished', label: t('transcriptionCopyScopeFinished', { count: finishedCount }) },
    { value: 'selected', label: t('transcriptionCopyScopeSelected', { count: selectedCount }) }
  ];
  const contents: { value: TranscriptionCopyContent; label: string }[] = [
    { value: 'both', label: t('transcriptionCopyContentBoth') },
    { value: 'transcript', label: t('transcriptionCopyContentTranscript') },
    { value: 'translation', label: t('transcriptionCopyContentTranslation') }
  ];

  return (
    <div className="transcription-copy-menu" ref={root}>
      <Button
        variant="secondary"
        className="transcription-copy-action"
        loading={busy}
        disabled={disabled}
        onClick={onCopy}
      >
        {scope === 'selected'
          ? t('transcriptionCopySelected', { count: selectedCount })
          : t('transcriptionCopyFinished', { count: finishedCount })}
      </Button>
      <button
        ref={trigger}
        type="button"
        className="transcription-copy-toggle"
        aria-label={t('transcriptionCopyOptions')}
        // "dialog", not the default "menu": what opens is a set of radio
        // choices, and announcing it as a menu tells a screen-reader user to
        // expect arrow-key menu navigation that is not there.
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen(value => !value)}
      >
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          className="transcription-copy-popover"
          id={popoverId}
          role="dialog"
          aria-label={t('transcriptionCopyOptions')}
        >
          <fieldset>
            <legend>{t('transcriptionCopyScopeTitle')}</legend>
            {scopes.map(option => (
              <label key={option.value}>
                <input
                  type="radio"
                  name={`${group}-scope`}
                  checked={scope === option.value}
                  onChange={() => onScopeChange(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t('transcriptionCopyContentTitle')}</legend>
            {contents.map(option => (
              <label key={option.value}>
                <input
                  type="radio"
                  name={`${group}-content`}
                  checked={content === option.value}
                  onChange={() => onContentChange(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}
