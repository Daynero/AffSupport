import { Card } from '../../components/Card';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { demoSpaces } from '../../review/fixtures/team-entry';
import type { ScreenProps } from '../../review/model';

export function TeamLobbyReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <section className="soty-tool-grid">
        {demoSpaces.map((space, index) => (
          <Card
            key={space}
            title={space}
            description={index === 2 ? 'Налаштування не завершене' : 'Готовий командний простір'}
            reviewId={`${props.referencePrefix}/space-${index}`}
            onOpen={() => props.dispatch({ type: 'advance-demo' })}
          />
        ))}
      </section>
    </ScreenScaffold>
  );
}
