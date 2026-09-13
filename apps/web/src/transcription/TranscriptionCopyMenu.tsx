import { useRef, useState } from 'react';
import { ChevronDown, ClipboardCopy } from 'lucide-react';
import { Button, type Translate } from '../components/ui';
import { Popover, RadioGroup } from '../components/ui/index';
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
  const trigger = useRef<HTMLButtonElement>(null);

  const scopes: { value: TranscriptionCopyScope; label: string }[] = [
    { value: 'finished', label: t('transcriptionCopyScopeFinished', { count: finishedCount }) },
    { value: 'selected', label: t('transcriptionCopyScopeSelected', { count: selectedCount }) }
  ];
  const contents: { value: TranscriptionCopyContent; label: string }[] = [
    { value: 'both', label: t('transcriptionCopyContentBoth') },
    { value: 'transcript', label: t('transcriptionCopyContentTranscript') },
    { value: 'translation', label: t('transcriptionCopyContentTranslation') }
  ];
  const label =
    scope === 'selected'
      ? t('transcriptionCopySelected', { count: selectedCount })
      : t('transcriptionCopyFinished', { count: finishedCount });

  return (
    <div className="transcription-copy-menu">
      <Button
        variant="secondary"
        className="transcription-copy-action"
        loading={busy}
        disabled={disabled}
        title={label}
        onClick={onCopy}
      >
        <ClipboardCopy size={18} strokeWidth={1.75} aria-hidden="true" />
        {/* Always in the DOM: the toolbar hides it with the same class that folds its
            neighbours. Removing it here made the row measure narrower without it, unfold,
            put it back, overflow, fold again — a flicker between two toolbars. */}
        <span className="action-label">{label}</span>
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
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        anchor={trigger}
        placement="bottom-end"
        label={t('transcriptionCopyOptions')}
        className="transcription-copy-popover"
      >
        <fieldset>
          <legend>{t('transcriptionCopyScopeTitle')}</legend>
          <RadioGroup
            label={t('transcriptionCopyScopeTitle')}
            value={scope}
            options={scopes}
            onChange={onScopeChange}
          />
        </fieldset>
        <fieldset>
          <legend>{t('transcriptionCopyContentTitle')}</legend>
          <RadioGroup
            label={t('transcriptionCopyContentTitle')}
            value={content}
            options={contents}
            onChange={onContentChange}
          />
        </fieldset>
      </Popover>
    </div>
  );
}
