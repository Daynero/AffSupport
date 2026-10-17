import { useId, type CSSProperties } from 'react';

export interface ProgressStage {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'complete' | 'attention';
  /** Measured fraction of this stage only; absent means its remaining work is unknown. */
  fraction?: number;
}

/** One line of observed stages. Segment positions never imply an overall percentage. */
export function StageProgress({
  stages,
  label,
  detail,
  active = true,
  stepsLabel,
  captionBelow = false
}: {
  stages: readonly ProgressStage[];
  label: string;
  detail?: string;
  active?: boolean;
  stepsLabel: string;
  captionBelow?: boolean;
}) {
  const id = useId();
  return (
    <div className={`ui-stage-progress${captionBelow ? ' ui-stage-progress--cells' : ''}`}>
      <div className="ui-stage-progress-heading" role="status" aria-live="polite">
        <strong id={id}>{label}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {active && (
        <div
          className="visually-hidden"
          role="progressbar"
          aria-labelledby={id}
          aria-valuetext={[label, detail].filter(Boolean).join(' · ')}
        />
      )}
      <ol className="ui-stage-progress-track" aria-label={stepsLabel}>
        {stages.map(stage => {
          const fraction = stage.state === 'complete' ? 1 : stage.fraction;
          const measured =
            fraction !== undefined && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
          return (
            <li
              key={stage.id}
              data-state={stage.state}
              aria-current={stage.state === 'active' ? 'step' : undefined}
              title={stage.label}
            >
              <span className="ui-stage-progress-segment" aria-hidden="true">
                <span
                  className={
                    measured
                      ? 'is-measured'
                      : active && stage.state === 'active'
                        ? 'is-waiting'
                        : ''
                  }
                  style={{ '--fill-ratio': measured ? fraction : 0 } as CSSProperties}
                />
              </span>
              <span className="ui-stage-progress-label">
                {stage.label}
                {stage.state === 'complete' ? ' ✓' : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
