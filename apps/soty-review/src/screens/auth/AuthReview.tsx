import { Action } from '../../components/Action';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { authProviders } from '../../review/fixtures/auth-shell';
import type { ScreenProps } from '../../review/model';

export function AuthReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <section className="soty-panel">
        <h2>Ласкаво просимо</h2>
        <p>Огляд не виконує вхід і не використовує справжній акаунт.</p>
        {authProviders.map(label => (
          <Action
            key={label}
            variant="secondary"
            reviewId={`${props.referencePrefix}/auth/${label}`}
            onClick={() => props.dispatch({ type: 'advance-demo' })}
          >
            {label}
          </Action>
        ))}
      </section>
    </ScreenScaffold>
  );
}
