import { ScreenScaffold } from '../../components/ScreenScaffold';
import { accountFacts } from '../../review/fixtures/home-account';
import type { ScreenProps } from '../../review/model';

export function AccountReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <section className="soty-panel">
        <h2>Профіль</h2>
        <dl>
          {accountFacts.map((fact, index) => (
            <div key={fact}>
              <dt>{['Імʼя', 'Email', 'Застосунок'][index]}</dt>
              <dd>{fact}</dd>
            </div>
          ))}
        </dl>
        <h3>Запрошення</h3>
        <p>Creative Studio · роль редактора · очікує рішення</p>
      </section>
    </ScreenScaffold>
  );
}
