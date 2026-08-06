import { Action } from '../../components/Action';
import { Card } from '../../components/Card';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { reviewTools } from '../../review/fixtures/home-account';
import type { ScreenProps } from '../../review/model';

export function HomeReview(props: ScreenProps) {
  const open = () => props.dispatch({ type: 'advance-demo' });
  return (
    <ScreenScaffold {...props}>
      <section aria-label="Інструменти" className="soty-tool-grid">
        {reviewTools.map((tool, index) => (
          <Card
            key={tool}
            title={tool}
            description={
              index === 0 ? 'Спільні матеріали й робота команди.' : 'Локальний інструмент Soty.'
            }
            reviewId={`${props.referencePrefix}/tool-${index}`}
            onOpen={open}
          >
            <Action
              variant={index === 0 ? 'primary' : 'secondary'}
              reviewId={`${props.referencePrefix}/tool-${index}-cta`}
              onClick={event => {
                event.stopPropagation();
                open();
              }}
            >
              Відкрити
            </Action>
          </Card>
        ))}
      </section>
    </ScreenScaffold>
  );
}
