import { useEffect } from 'react';
import { HoneycombField } from './components/HoneycombField';
import { ReviewCatalog } from './components/ReviewCatalog';
import { ReviewChrome } from './components/ReviewChrome';
import { findSurface, reviewCatalog } from './review/catalog';
import { parseReviewHash, serializeReviewRoute } from './review/router';
import { ReviewProvider, useReview } from './review/reducer';
import { ScreenRegistry } from './screens/ScreenRegistry';

function ReviewContent() {
  const { state, dispatch } = useReview();
  const { route } = state;
  useEffect(() => {
    const syncFromHash = () =>
      dispatch({ type: 'navigate', route: parseReviewHash(location.hash) });
    addEventListener('hashchange', syncFromHash);
    return () => removeEventListener('hashchange', syncFromHash);
  }, [dispatch]);
  useEffect(() => {
    const serialized = serializeReviewRoute(route);
    if (location.hash !== serialized.slice(1)) location.hash = serialized.slice(1);
  }, [route]);
  useEffect(() => {
    document.documentElement.lang = route.locale === 'uk' ? 'uk' : 'en';
    document.title = `${reviewCatalog.iteration} — Soty UI Review`;
    document.querySelector('.soty-review')?.setAttribute('data-soty-theme', route.theme);
  }, [route.locale, route.theme]);
  if (route.kind === 'catalog')
    return (
      <>
        <HoneycombField theme={route.theme} />
        <ReviewChrome route={route} dispatch={dispatch}>
          <ReviewCatalog route={route} dispatch={dispatch} />
        </ReviewChrome>
      </>
    );
  const surface = findSurface(route.surfaceId);
  const selected = surface?.states.find(item => item.id === route.stateId);
  if (!surface || !selected) return null;
  const index = reviewCatalog.surfaces.findIndex(item => item.id === surface.id);
  const referencePrefix = `${reviewCatalog.iteration}/${surface.id}/${selected.id}`;
  const model = { ...selected.model, advanced: state.advanced, overlay: state.overlay };
  return (
    <>
      <HoneycombField theme={route.theme} />
      <ReviewChrome route={route} dispatch={dispatch}>
        <nav className="soty-statebar" aria-label="Навігація оглядом екрана">
        <button
          type="button"
          onClick={() =>
            dispatch({
              type: 'navigate',
              route: { kind: 'catalog', theme: route.theme, locale: route.locale }
            })
          }
          data-review-id={`${referencePrefix}/back-catalog`}
          data-demo-action
        >
          ← Каталог
        </button>
        <div className="soty-state-chips" aria-label="Стани екрана">
          {surface.states.map(item => (
            <button
              type="button"
              key={item.id}
              aria-pressed={item.id === selected.id}
              onClick={() => dispatch({ type: 'select-state', stateId: item.id })}
              data-review-id={`${referencePrefix}/state-${item.id}`}
              data-demo-action
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            const next = reviewCatalog.surfaces[(index + 1) % reviewCatalog.surfaces.length];
            dispatch({
              type: 'navigate',
              route: {
                kind: 'screen',
                surfaceId: next.id,
                stateId: next.primaryStateId,
                theme: route.theme,
                locale: route.locale
              }
            });
          }}
          data-review-id={`${referencePrefix}/next-screen`}
          data-demo-action
        >
          Наступний екран →
        </button>
      </nav>
      <ScreenRegistry
        surfaceId={surface.id}
        model={model}
        referencePrefix={referencePrefix}
        dispatch={dispatch}
      />
      </ReviewChrome>
    </>
  );
}

export default function ReviewApp() {
  const initial = parseReviewHash(location.hash);
  return (
    <div className="soty-review" data-soty-theme={initial.theme}>
      <ReviewProvider initial={initial}>
        <ReviewContent />
      </ReviewProvider>
    </div>
  );
}
