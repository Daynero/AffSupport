import { Disclosure } from '../../components/Disclosure';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { compressorOptions } from '../../review/fixtures/compressor';
import type { ScreenProps } from '../../review/model';

export function CompressorReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props} showDisclosure={false}>
      <section className="soty-panel">
        <h2>Поточний вибір</h2>
        <ul>
          {compressorOptions.map(option => (
            <li key={option}>✓ {option}</li>
          ))}
        </ul>
        <p>
          <strong>Наслідок:</strong> демо покаже стислий результат, не торкаючись файлів.
        </p>
      </section>
      <Disclosure
        open={Boolean(props.model.advanced)}
        onToggle={() => props.dispatch({ type: 'toggle-disclosure' })}
      >
        <label>
          CRF <input type="number" defaultValue="26" aria-label="CRF" />
        </label>
        <label>
          Роздільність{' '}
          <select aria-label="Роздільність" defaultValue="720">
            <option value="720">720p</option>
            <option value="1080">1080p</option>
          </select>
        </label>
      </Disclosure>
    </ScreenScaffold>
  );
}
