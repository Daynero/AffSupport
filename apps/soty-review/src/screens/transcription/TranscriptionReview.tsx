import { Disclosure } from '../../components/Disclosure';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { transcriptPreview, transcriptionLanguages } from '../../review/fixtures/transcription';
import type { ScreenProps } from '../../review/model';

export function TranscriptionReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props} showDisclosure={false}>
      <section className="soty-panel">
        <h2>Текст</h2>
        <blockquote>{transcriptPreview}</blockquote>
        <p>Переклад: локальний демонстраційний результат.</p>
      </section>
      <Disclosure
        open={Boolean(props.model.advanced)}
        onToggle={() => props.dispatch({ type: 'toggle-disclosure' })}
      >
        <label>
          Мова{' '}
          <select defaultValue={transcriptionLanguages[0]}>
            {transcriptionLanguages.map(language => (
              <option key={language}>{language}</option>
            ))}
          </select>
        </label>
      </Disclosure>
    </ScreenScaffold>
  );
}
