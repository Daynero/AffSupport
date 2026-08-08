import { ScreenScaffold } from '../../components/ScreenScaffold';
import { galleryFolders } from '../../review/fixtures/landing-gallery';
import type { ScreenProps } from '../../review/model';

export function LandingGalleryReview(props: ScreenProps) {
  return (
    <ScreenScaffold {...props}>
      <div className="soty-gallery">
        <aside>
          <h2>Структура</h2>
          {galleryFolders.map(item => (
            <button
              type="button"
              key={item}
              data-demo-action
              data-review-id={`${props.referencePrefix}/tree/${item}`}
              onClick={() => props.dispatch({ type: 'advance-demo' })}
            >
              {item}
            </button>
          ))}
        </aside>
        <section className="soty-preview">
          <h2>Безпечний preview</h2>
          <div className="soty-preview-frame">Soty landing preview · scripts/network disabled</div>
        </section>
      </div>
    </ScreenScaffold>
  );
}
