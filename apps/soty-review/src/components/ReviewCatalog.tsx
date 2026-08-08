import { reviewCatalog } from '../review/catalog';
import type { DemoAction, ReviewRoute } from '../review/model';
import { Card } from './Card';

export function ReviewCatalog({
  route,
  dispatch
}: {
  route: Extract<ReviewRoute, { kind: 'catalog' }>;
  dispatch: (action: DemoAction) => void;
}) {
  return (
    <main className="soty-catalog">
      <header className="soty-screen-heading">
        <p className="soty-eyebrow">ПОВНИЙ КАТАЛОГ · {reviewCatalog.iteration}</p>
        <h1>Огляд інтерфейсу Soty</h1>
        <p>Кожний екран і стан працює лише з локальними демонстраційними даними.</p>
      </header>
      {route.notice && (
        <div className="soty-message" role="status">
          {route.notice}
        </div>
      )}
      <div className="soty-catalog-grid">
        {reviewCatalog.surfaces.map(surface => (
          <Card
            key={surface.id}
            title={surface.title}
            description={`${surface.states.length} станів · ${surface.routeHint}`}
            reviewId={`${reviewCatalog.iteration}/${surface.id}/catalog/card`}
            onOpen={() =>
              dispatch({
                type: 'navigate',
                route: {
                  kind: 'screen',
                  surfaceId: surface.id,
                  stateId: surface.primaryStateId,
                  theme: route.theme,
                  locale: route.locale
                }
              })
            }
          />
        ))}
      </div>
      <details className="soty-exclusions">
        <summary>Явні виключення зі scope</summary>
        <ul>
          {reviewCatalog.exclusions.map(item => (
            <li key={item.id}>
              <strong>{item.id}</strong>: {item.rationale}
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}
