import { ScreenScaffold } from '../../components/ScreenScaffold';
import type { ScreenProps } from '../../review/model';

export function CreateSpaceReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <ol className="soty-steps">
        <li className="is-current">1. Назва простору</li>
        <li>2. Папка Drive</li>
        <li>3. Готово</li>
      </ol>
      <section className="soty-panel">
        <label>
          Назва простору
          <input defaultValue="Creative Studio" />
        </label>
        <p>Папка: демонстраційна · реальне сховище не підключається.</p>
      </section>
    </ScreenScaffold>
  );
}
