import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import { reviewCatalog } from './catalog';
import type { DemoAction, ReviewRoute } from './model';

export type ReviewState = {
  route: ReviewRoute;
  advanced: boolean;
  overlay: 'none' | 'details' | 'confirmation';
  demoStep: number;
};

export function reviewReducer(state: ReviewState, action: DemoAction): ReviewState {
  switch (action.type) {
    case 'navigate':
      return { ...state, route: action.route, advanced: false, overlay: 'none' };
    case 'select-state':
      return state.route.kind === 'screen'
        ? { ...state, route: { ...state.route, stateId: action.stateId }, overlay: 'none' }
        : state;
    case 'set-theme':
      return { ...state, route: { ...state.route, theme: action.theme } };
    case 'set-locale':
      return { ...state, route: { ...state.route, locale: action.locale } };
    case 'toggle-disclosure':
      return { ...state, advanced: !state.advanced };
    case 'open-overlay':
      return { ...state, overlay: action.overlay };
    case 'close-overlay':
      return { ...state, overlay: 'none' };
    case 'advance-demo':
      return { ...state, demoStep: state.demoStep + 1 };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

const initialRoute: ReviewRoute = {
  kind: 'catalog',
  theme: reviewCatalog.themes[0],
  locale: reviewCatalog.locales[0]
};

const ReviewContext = createContext<
  { state: ReviewState; dispatch: Dispatch<DemoAction> } | undefined
>(undefined);

export function ReviewProvider({
  initial = initialRoute,
  children
}: {
  initial?: ReviewRoute;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reviewReducer, {
    route: initial,
    advanced: false,
    overlay: 'none',
    demoStep: 0
  });
  return <ReviewContext.Provider value={{ state, dispatch }}>{children}</ReviewContext.Provider>;
}

export function useReview() {
  const value = useContext(ReviewContext);
  if (!value) throw new Error('SOTY_REVIEW_PROVIDER_MISSING');
  return value;
}
