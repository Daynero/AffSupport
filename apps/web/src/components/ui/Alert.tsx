import { Alert as HeroAlert } from '@heroui/react/alert';
import { type HTMLAttributes, type ReactNode } from 'react';
import { uiClasses, type UiColor, type UiVariant } from './types';

/**
 * Alert (021 T017, on HeroUI in 024).
 *
 * Everything the product says in place rather than in a toast: an inline error,
 * a note about beta storage, a warning that the space is read-only, a notice
 * that the agent is missing. Today those are `.team-inline-error`,
 * `.team-inline-note`, `.team-test-mode-note` and a handful of bare paragraphs
 * with a colour on them — four shapes for one job.
 *
 * An alert says what is true and, where something can be done, carries the
 * control that does it. It never carries only a colour: the icon and the title
 * say the same thing for a reader who cannot see the hue (FR-032).
 */

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  color?: Extract<UiColor, 'info' | 'success' | 'warning' | 'error' | 'neutral'>;
  variant?: Extract<UiVariant, 'soft' | 'subtle' | 'outline'>;
  icon?: ReactNode;
  title?: ReactNode;
  /** The action that resolves it — a retry, a reconnect, a way to the setting. */
  action?: ReactNode;
  /** `alert` for something that just failed; `status` for a standing note. */
  live?: 'alert' | 'status' | 'none';
}

export function Alert({
  color = 'info',
  variant = 'soft',
  icon,
  title,
  action,
  live = 'status',
  className,
  children,
  ...props
}: AlertProps) {
  return (
    <HeroAlert
      {...props}
      role={live === 'none' ? undefined : live}
      className={uiClasses('alert', { color, variant, className })}
    >
      {icon && (
        <HeroAlert.Indicator className="ui-alert-icon" aria-hidden="true">
          {icon}
        </HeroAlert.Indicator>
      )}
      <HeroAlert.Content className="ui-alert-body">
        {title && <HeroAlert.Title className="ui-alert-title">{title}</HeroAlert.Title>}
        {children !== undefined && children !== null && children !== false && (
          <p className="ui-alert-text prose">{children}</p>
        )}
      </HeroAlert.Content>
      {action && <div className="ui-alert-action">{action}</div>}
    </HeroAlert>
  );
}
