import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredLayer } from '../components/useAnchoredLayer';
import { ChevronDown, Download } from 'lucide-react';
import { Button, type Translate } from '../components/ui';
import type { TranscriptExportContent, TranscriptExportFormat } from './export';

/**
 * "Download" with a choice of shape.
 *
 * The button itself saves the plain transcript — the thing most people want — and the
 * menu beside it offers subtitles and the translation. Subtitle formats are disabled, not
 * hidden, when the document has no timings, so the person learns why rather than wondering
 * where SRT went.
 */
export function ExportMenu({
  hasTimings,
  hasTranslation,
  busy = false,
  disabled = false,
  compact = false,
  portal = false,
  onExport,
  t
}: {
  hasTimings: boolean;
  hasTranslation: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** Icon-only trigger, for a row where every word is fought over. */
  compact?: boolean;
  /** Rendered on the body and placed beside the button: inside a list card the card clips it. */
  portal?: boolean;
  onExport: (format: TranscriptExportFormat, content: TranscriptExportContent) => void;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const layerStyle = useAnchoredLayer(root, menu, open && portal, { align: 'end', gap: 6 });

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) toggle.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // A menu takes the keyboard: focus lands on its first choice, arrows move between
    // the enabled ones, Escape closes the menu and nothing above it — inside the viewer
    // it used to fall through and close the whole dialog.
    const items = () =>
      Array.from(
        menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
      );
    items()[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Node;
      const inside = root.current?.contains(target) || menu.current?.contains(target);
      if (!inside && event.key !== 'Escape') return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === 'Tab') {
        // Tab leaves the menu the way Escape does: back on the toggle. Portalled to the end
        // of the body, the menu has nothing after it, and a natural Tab out of it landed on
        // the first link of the page.
        event.preventDefault();
        close(true);
        return;
      }
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        list[(index + 1) % list.length]?.focus();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      } else if (event.key === 'Home') {
        list[0]?.focus();
      } else if (event.key === 'End') {
        list.at(-1)?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const choose = (format: TranscriptExportFormat, content: TranscriptExportContent) => {
    close(true);
    onExport(format, content);
  };
  const formats: Array<{ format: TranscriptExportFormat; label: string; enabled: boolean }> = [
    { format: 'txt', label: t('transcriptionExportTxt'), enabled: true },
    { format: 'srt', label: t('transcriptionExportSrt'), enabled: hasTimings },
    { format: 'vtt', label: t('transcriptionExportVtt'), enabled: hasTimings }
  ];
  const contents: Array<{ content: TranscriptExportContent; label: string; enabled: boolean }> = [
    { content: 'transcript', label: t('transcriptionCopyContentTranscript'), enabled: true },
    {
      content: 'translation',
      label: t('transcriptionCopyContentTranslation'),
      enabled: hasTranslation
    },
    { content: 'both', label: t('transcriptionCopyContentBoth'), enabled: hasTranslation }
  ];

  // One markup for both homes: on the body beside a list card, in place inside the viewer.
  const popover = (
    <div
      id={menuId}
      ref={menu}
      role="menu"
      className={`transcription-export-popover${portal ? ' is-portal' : ''}`}
      style={portal ? (layerStyle ?? undefined) : undefined}
    >
      {contents.map(entry => (
        <div
          key={entry.content}
          className="transcription-export-group"
          role="group"
          aria-labelledby={`${menuId}-${entry.content}`}
        >
          <span id={`${menuId}-${entry.content}`} className="transcription-export-group-title">
            {entry.label}
          </span>
          <div className="transcription-export-formats">
            {formats.map(item => (
              <button
                key={`${entry.content}-${item.format}`}
                type="button"
                role="menuitem"
                disabled={!entry.enabled || !item.enabled}
                onClick={() => choose(item.format, entry.content)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {/* Why something is greyed out, said once where everyone can read it — a title on a
      disabled button reaches neither the keyboard nor a finger. */}
      {(!hasTimings || !hasTranslation) && (
        <p className="transcription-export-note">
          {!hasTimings && <span>{t('transcriptionExportNoTimings')}</span>}
          {!hasTranslation && <span>{t('transcriptionExportNoTranslation')}</span>}
        </p>
      )}
    </div>
  );

  return (
    <div className="transcription-export-menu" ref={root}>
      <Button
        variant="secondary"
        className="transcription-export-action"
        title={t('transcriptionExport')}
        loading={busy}
        disabled={disabled}
        onClick={() => choose('txt', 'transcript')}
      >
        <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        {!compact && <span className="action-label">{t('transcriptionExport')}</span>}
      </Button>
      <button
        ref={toggle}
        type="button"
        className="transcription-export-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t('transcriptionExportOptions')}
        disabled={disabled || busy}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (portal ? createPortal(popover, document.body) : popover)}
    </div>
  );
}
