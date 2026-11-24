import { useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import type { Translate } from '../i18n';
import { Button, DropdownMenu, type MenuEntry } from '../components/ui/index';
import type { TranscriptExportContent, TranscriptExportFormat } from './export';

/**
 * Download: a split control. The button saves the plain text straight away; the caret
 * beside it opens every format.
 *
 * The menu is the inventory's (070 T035): focus lands on the first choice, arrows walk
 * the enabled ones with Home and End, Escape closes the menu and nothing above it — inside
 * the viewer it used to fall through and close the whole dialog — and Tab leaves it. It is
 * on the body and flips above the caret when there is no room below, so neither a list
 * card nor the viewer's footer clips it.
 */
export function ExportMenu({
  hasTimings,
  busy = false,
  disabled = false,
  compact = false,
  onExport,
  t
}: {
  hasTimings: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** Icon-only trigger, for a row where every word is fought over. */
  compact?: boolean;
  onExport: (format: TranscriptExportFormat, content: TranscriptExportContent) => void;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  const formats: Array<{ format: TranscriptExportFormat; label: string; timed: boolean }> = [
    { format: 'txt', label: t('transcriptionExportTxt'), timed: false },
    { format: 'srt', label: t('transcriptionExportSrt'), timed: true },
    { format: 'vtt', label: t('transcriptionExportVtt'), timed: true }
  ];
  const contents: Array<{ content: TranscriptExportContent; label: string }> = [
    { content: 'transcript', label: t('transcriptionCopyContentTranscript') }
  ];
  const items: MenuEntry[] = contents.flatMap(entry => [
    { heading: entry.label },
    ...formats.map(item => {
      const available = hasTimings || !item.timed;
      return {
        id: `${entry.content}-${item.format}`,
        label: item.label,
        disabled: !available,
        // Why it is greyed out, said on the item itself: a title on a disabled control
        // reaches neither the keyboard nor a finger.
        note: available ? undefined : t('transcriptionExportNoTimings'),
        onSelect: () => onExport(item.format, entry.content)
      };
    })
  ]);

  return (
    <div className="transcription-export-menu">
      <Button
        variant="secondary"
        className="transcription-export-action"
        title={t('transcriptionExport')}
        loading={busy}
        disabled={disabled}
        onClick={() => onExport('txt', 'transcript')}
      >
        <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        {!compact && <span className="action-label">{t('transcriptionExport')}</span>}
      </Button>
      <Button
        ref={toggle}
        variant="secondary"
        className="transcription-export-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('transcriptionExportOptions')}
        title={t('transcriptionExportOptions')}
        disabled={disabled || busy}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </Button>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={toggle}
        placement="bottom-end"
        minWidth={200}
        label={t('transcriptionExportOptions')}
        items={items}
      />
    </div>
  );
}
