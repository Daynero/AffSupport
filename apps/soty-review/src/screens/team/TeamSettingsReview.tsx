import { Confirmation } from '../../components/Confirmation';
import { NestedLevel } from '../../components/NestedLevel';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { teamSections } from '../../review/fixtures/team-workspace';
import type { ScreenProps } from '../../review/model';

export function TeamSettingsReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <NestedLevel
        title="Налаштування простору"
        onBack={() => props.dispatch({ type: 'advance-demo' })}
      >
        <div className="soty-chip-row">
          {teamSections.slice(2).map(section => (
            <span className="soty-status is-ready" key={section}>
              ✓ {section}
            </span>
          ))}
        </div>
        <Confirmation onConfirm={() => props.dispatch({ type: 'advance-demo' })} />
      </NestedLevel>
    </ScreenScaffold>
  );
}
