import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TranscriptionJob } from '@video-compressor/shared';
import { Button, type Translate } from '../components/ui';
import { languageDisplayName } from './language';
import type { Language } from '../i18n';

export function TranscriptTextModal({
  job,
  language,
  returnFocus,
  onClose,
  t
}: {
  job: TranscriptionJob;
  language: Language;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  t: Translate;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const text = job.text ?? '';
  const detected = job.detectedLanguage
    ? languageDisplayName(job.detectedLanguage, language)
    : null;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.requestAnimationFrame(() => {
      dialog.current?.querySelector<HTMLButtonElement>('.transcript-modal-close')?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (copyTimer.current) clearTimeout(copyTimer.current);
      returnFocus?.focus();
    };
  }, [onClose, returnFocus]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked; the textarea below still allows manual copy.
    }
  };

  return createPortal(
    <div
      className="transcript-modal-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="transcript-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="transcript-modal-header">
          <div>
            <h2 id={titleId}>{job.fileName}</h2>
            <p>
              {detected && <span>{t('transcriptionDetected', { language: detected })}</span>}
              {job.characters !== null && (
                <span>{t('transcriptionCharacters', { count: job.characters })}</span>
              )}
            </p>
          </div>
          <button
            type="button"
            className="transcript-modal-close"
            aria-label={t('transcriptionModalClose')}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="transcript-modal-body">
          {text ? (
            <textarea
              className="transcript-modal-text"
              value={text}
              readOnly
              spellCheck={false}
              aria-label={job.fileName}
            />
          ) : (
            <div className="transcript-modal-empty">{t('transcriptionModalEmpty')}</div>
          )}
        </div>

        <footer className="transcript-modal-footer">
          <Button variant="ghost" onClick={onClose}>
            {t('transcriptionModalClose')}
          </Button>
          <Button variant="primary" disabled={!text} onClick={() => void copy()}>
            {copied ? t('transcriptionCopied') : t('transcriptionCopy')}
          </Button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
