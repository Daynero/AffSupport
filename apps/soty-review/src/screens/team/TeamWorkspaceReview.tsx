import { Action } from '../../components/Action';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { teamSections } from '../../review/fixtures/team-workspace';
import type { ScreenProps } from '../../review/model';

export function TeamWorkspaceReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <nav className="soty-chip-row" aria-label="Розділи простору">
        {teamSections.slice(0, 3).map(section => (
          <Action
            key={section}
            variant="ghost"
            reviewId={`${props.referencePrefix}/section/${section}`}
            onClick={() => props.dispatch({ type: 'advance-demo' })}
          >
            {section}
          </Action>
        ))}
      </nav>
      <section className="soty-panel">
        <h2>Матеріали команди</h2>
        <p>Пошук і фільтри відкриваються за потреби. Поточна папка: Creative Studio.</p>
      </section>
    </ScreenScaffold>
  );
}
