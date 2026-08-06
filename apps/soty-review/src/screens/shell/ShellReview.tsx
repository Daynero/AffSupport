import { ScreenScaffold } from '../../components/ScreenScaffold';
import { Status } from '../../components/Controls';
import { connectionStates } from '../../review/fixtures/auth-shell';
import type { ScreenProps } from '../../review/model';

export function ShellReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <section className="soty-panel">
        <h2>Стани оболонки</h2>
        <div className="soty-chip-row">
          {connectionStates.map((state, index) => (
            <Status
              key={state}
              tone={index === 1 ? 'ready' : index === 2 ? 'warning' : 'development'}
            >
              {state}
            </Status>
          ))}
        </div>
      </section>
    </ScreenScaffold>
  );
}
