import { Action } from '../../components/Action';
import { Card } from '../../components/Card';
import { Progress } from '../../components/Progress';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { Status } from '../../components/Controls';
import type { ScreenProps } from '../../review/model';

export function ComponentShowcase(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <section className="soty-panel">
        <h2>Дії</h2>
        <div className="soty-actions">
          <Action variant="primary" reviewId={`${props.referencePrefix}/showcase-primary`}>
            Головна
          </Action>
          <Action variant="secondary" reviewId={`${props.referencePrefix}/showcase-secondary`}>
            Другорядна
          </Action>
          <Action variant="ghost" reviewId={`${props.referencePrefix}/showcase-ghost`}>
            Тиха
          </Action>
          <Action disabled reviewId={`${props.referencePrefix}/showcase-disabled`}>
            Недоступна
          </Action>
        </div>
        <h2>Стани</h2>
        <div className="soty-chip-row">
          <Status tone="ready">Готово</Status>
          <Status tone="active">Активно</Status>
          <Status tone="development">У розробці</Status>
        </div>
        <Progress value={72} label="Приклад прогресу" />
        <Card
          title="Картка інструмента"
          description="Стала позиція назви, опису, статусу та дії."
          reviewId={`${props.referencePrefix}/showcase-card`}
        />
      </section>
    </ScreenScaffold>
  );
}
