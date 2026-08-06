import { reviewCatalog } from '../review/catalog';
import type { DemoAction, ReviewLocale, ReviewRoute, Theme } from '../review/model';
import { SegmentedControl } from './Controls';
import { SotyLogo } from './SotyLogo';

export function ReviewChrome({
  route,
  dispatch,
  children
}: {
  route: ReviewRoute;
  dispatch: (action: DemoAction) => void;
  children: React.ReactNode;
}) {
  const catalogRoute = { kind: 'catalog' as const, theme: route.theme, locale: route.locale };
  return (
    <div className="soty-layout">
      <header className="soty-topbar">
        <button
          className="soty-brand-button"
          type="button"
          onClick={() => dispatch({ type: 'navigate', route: catalogRoute })}
          data-demo-action
          data-review-id="chrome/catalog"
        >
          <SotyLogo />
        </button>
        <span className="soty-iteration">Локальна копія · {reviewCatalog.iteration}</span>
        <div className="soty-topbar-controls">
          <SegmentedControl<Theme>
            label="Тема"
            value={route.theme}
            options={[
              { value: 'light', label: 'Світла' },
              { value: 'dark', label: 'Темна' }
            ]}
            onChange={theme => dispatch({ type: 'set-theme', theme })}
          />
          <SegmentedControl<ReviewLocale>
            label="Мова"
            value={route.locale}
            options={[
              { value: 'uk', label: 'UA' },
              { value: 'en-long', label: 'EN+' }
            ]}
            onChange={locale => dispatch({ type: 'set-locale', locale })}
          />
        </div>
      </header>
      {children}
    </div>
  );
}
