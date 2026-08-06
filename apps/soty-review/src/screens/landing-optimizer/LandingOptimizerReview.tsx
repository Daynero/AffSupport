import { Disclosure } from '../../components/Disclosure';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { landingOptions } from '../../review/fixtures/landing-optimizer';
import type { ScreenProps } from '../../review/model';

export function LandingOptimizerReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props} showDisclosure={false}>
      <section className="soty-panel">
        <h2>Безпечні параметри</h2>
        <ul>
          {landingOptions.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="soty-compare">
          <span>До · 8.4 MB</span>
          <span>Після · 3.1 MB</span>
        </div>
      </section>
      <Disclosure
        open={Boolean(props.model.advanced)}
        onToggle={() => props.dispatch({ type: 'toggle-disclosure' })}
      >
        <label>
          Якість зображень <input type="range" min="40" max="100" defaultValue="82" />
        </label>
      </Disclosure>
    </ScreenScaffold>
  );
}
