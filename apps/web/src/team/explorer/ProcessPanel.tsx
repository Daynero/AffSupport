import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ProgressBar } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

/**
 * One place where long local work reports itself.
 *
 * Transcription, compression and a re-stitched download are different jobs with the same
 * shape: a name, a file, a bar, and a way out. They had drifted into separate treatments, and
 * the one that existed sat on top of the file details on a small screen — so watching the
 * progress meant losing the thing being worked on.
 *
 * Two decisions carry the design:
 *
 * - **It collapses to a strip.** Not a close button: closing would hide work that is still
 *   running, and the panel's whole purpose is that the machine is busy. Collapsed it keeps the
 *   process name and the bar, and gives the screen back.
 * - **The step is named, not only counted.** "Transferring", "recognising", "saving" answer
 *   "is it stuck?" in a way a percentage never does, which is the question a bar that moves
 *   slowly always provokes.
 */
export interface ProcessPanelAction {
  label: string;
  run: () => void;
  /** The one that abandons the work; rendered apart from the rest. */
  destructive?: boolean;
}

export function ProcessPanel({
  title,
  detail,
  phase,
  progress,
  active,
  actions,
  children
}: {
  /** The process, in one or two words. Shown collapsed as well. */
  title: string;
  /** What it is working on right now — a file name, or a count. */
  detail?: string | null;
  /** The step it is on, in words. */
  phase?: string | null;
  progress: number;
  /** False while held, so the bar stops animating and says so. */
  active: boolean;
  actions: ProcessPanelAction[];
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  // A new process opens the panel again: a strip left over from the last one would hide the
  // start of this one.
  useEffect(() => setCollapsed(false), [title]);

  return (
    <aside
      className={`team-process-panel ${collapsed ? 'is-collapsed' : ''}`.trim()}
      aria-live="polite"
    >
      <div className="team-process-panel-head">
        <strong className="team-process-panel-title">{title}</strong>
        <button
          type="button"
          className="team-process-panel-toggle"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'teamProcessExpand' : 'teamProcessCollapse')}
          data-tip={t(collapsed ? 'teamProcessExpand' : 'teamProcessCollapse')}
          onClick={() => setCollapsed(current => !current)}
        >
          {collapsed ? (
            <ChevronUp size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          ) : (
            <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Kept mounted while collapsed so the bar is the one thing a strip still shows. */}
      <ProgressBar value={progress} active={active} label={title} />

      {!collapsed && (
        <>
          {detail && <p className="team-process-panel-detail">{detail}</p>}
          {phase && <p className="team-process-panel-phase">{phase}</p>}
          {children}
          <div className="team-process-panel-actions">
            {actions
              .filter(action => !action.destructive)
              .map(action => (
                <button
                  key={action.label}
                  type="button"
                  className="button button-ghost"
                  onClick={action.run}
                >
                  {action.label}
                </button>
              ))}
            {actions
              .filter(action => action.destructive)
              .map(action => (
                <button
                  key={action.label}
                  type="button"
                  className="button button-ghost team-process-panel-stop"
                  onClick={action.run}
                >
                  {action.label}
                </button>
              ))}
          </div>
        </>
      )}
    </aside>
  );
}
