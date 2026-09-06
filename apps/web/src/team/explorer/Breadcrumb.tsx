import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useExplorer } from './ExplorerProvider';

/**
 * How deep a path is shown in full before the middle folds away.
 *
 * A path of four or more ran past the toolbar and was cut mid-word — "…айли /
 * OneMedi" beside the Search button, with no way to read where you were or to
 * step back to anywhere but the root. Two ancestors and the open folder is what
 * a person needs to see; the rest is one press away.
 */
const VISIBLE_TAIL = 2;

export function Breadcrumb() {
  const { t } = useI18n();
  const { currentFolderId, pathTo, openFolder } = useExplorer();
  const path = pathTo(currentFolderId);
  const folded = path.length > VISIBLE_TAIL + 1 ? path.slice(0, path.length - VISIBLE_TAIL) : [];
  const shown = folded.length > 0 ? path.slice(path.length - VISIBLE_TAIL) : path;

  /*
   * The whole trail behind the open folder, for the strip too narrow to show
   * any of it. Below about 360px there is room for one name, and it has to be
   * the folder a person is standing in — so everything above it, the root
   * included, goes into one menu. CSS chooses which of the two renderings is
   * on; both are always in the document, so the way back never depends on a
   * width.
   */
  const ancestors = path.slice(0, path.length - 1);

  return (
    <nav className="team-explorer-breadcrumb" aria-label={t('teamExplorerBreadcrumbLabel')}>
      <ol>
        {path.length > 0 && (
          <li className="team-explorer-breadcrumb-compact">
            <FoldedPath
              nodes={[
                { id: 'root', driveFileId: '', name: t('teamExplorerRootLabel') },
                ...ancestors
              ]}
              onOpen={driveFileId => openFolder(driveFileId === '' ? null : driveFileId)}
              label={t('teamExplorerBreadcrumbFolded', { count: ancestors.length + 1 })}
            />
            <Separator />
          </li>
        )}
        <li className="team-explorer-breadcrumb-step">
          {path.length === 0 ? (
            <span aria-current="page">{t('teamExplorerRootLabel')}</span>
          ) : (
            <button type="button" onClick={() => openFolder(null)}>
              {t('teamExplorerRootLabel')}
            </button>
          )}
        </li>
        {folded.length > 0 && (
          <li className="team-explorer-breadcrumb-step">
            <Separator />
            <FoldedPath
              nodes={folded}
              onOpen={driveFileId => openFolder(driveFileId)}
              label={t('teamExplorerBreadcrumbFolded', { count: folded.length })}
            />
          </li>
        )}
        {shown.map((node, index) => (
          <li
            key={node.id}
            className={index === shown.length - 1 ? '' : 'team-explorer-breadcrumb-step'}
          >
            <Separator
              className={index === shown.length - 1 ? 'team-explorer-breadcrumb-step' : ''}
            />
            {index === shown.length - 1 ? (
              <span aria-current="page" title={node.name}>
                {node.name}
              </span>
            ) : (
              <button type="button" title={node.name} onClick={() => openFolder(node.driveFileId)}>
                {node.name}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Separator({ className = '' }: { className?: string }) {
  return (
    <span className={`team-explorer-breadcrumb-separator ${className}`.trim()} aria-hidden="true">
      /
    </span>
  );
}

/** The ancestors the row has no space for, still one press away. */
function FoldedPath({
  nodes,
  onOpen,
  label
}: {
  nodes: { id: string; driveFileId: string; name: string }[];
  onOpen: (driveFileId: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      button.current?.focus();
      setOpen(false);
      return;
    }
    const items = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
  };

  return (
    <div className="team-explorer-breadcrumb-folded" ref={box}>
      <button
        type="button"
        ref={button}
        className="team-explorer-breadcrumb-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(value => !value)}
      >
        …
      </button>
      {open && (
        <div
          className="team-explorer-menu"
          role="menu"
          aria-label={label}
          ref={list}
          onKeyDown={onListKeyDown}
        >
          {nodes.map(node => (
            <button
              key={node.id}
              type="button"
              role="menuitem"
              className="team-explorer-menu-item"
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                onOpen(node.driveFileId);
              }}
            >
              {node.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
