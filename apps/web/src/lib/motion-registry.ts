/**
 * The transition registry (058, FR-001/FR-026).
 *
 * Every screen the web app can show has one entry here, and every route maps
 * to one of them. The entry says how the screen is entered, which skeleton
 * stands in while its code loads, and whether the frame-by-frame smoke test
 * (`scripts/motion-smoke.mjs`) walks it. Analytics reports the same
 * `ScreenKind`, so "which screen was slow" and "which screen is covered" are
 * answered from one list.
 *
 * This module is imported by the router, which sits in the eager entry chunk:
 * it must stay free of page and registry imports (tool-registry pulls every
 * tool page in). Tool paths are therefore listed here and a test holds them
 * equal to the tool registry.
 */

export const SCREEN_KINDS = [
  'public_home',
  'public_legal',
  'auth',
  'tools_home',
  'tool',
  'account',
  'admin',
  'team_lobby',
  'team_explorer',
  'team_tasks',
  'team_launches',
  'team_accounts',
  'team_members',
  'team_trash',
  'other'
] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

/**
 * - `page`: another area of the app; the page content crossfades under a
 *   still shell.
 * - `section`: another section of the same space; only the space body
 *   crossfades, the space header and tabs stay put.
 * - `none`: an adjustment within the screen (a folder, a filter, an open
 *   task, a dialog written to the address); nothing page-wide moves.
 */
export type MotionKind = 'page' | 'section' | 'none';

export type RouteSkeletonVariant =
  'tool' | 'settings' | 'lobby' | 'workspace' | 'list' | 'tiles' | 'board';

export interface RegistryEntry {
  screen: ScreenKind;
  /** How the screen is entered from another screen. */
  motion: Exclude<MotionKind, 'none'>;
  /** The skeleton shown while the screen's code loads; null when it is eager. */
  skeleton: RouteSkeletonVariant | null;
  /** Walked by the frame-by-frame smoke test. */
  smoke: boolean;
}

export const MOTION_REGISTRY: readonly RegistryEntry[] = [
  { screen: 'public_home', motion: 'page', skeleton: null, smoke: false },
  { screen: 'public_legal', motion: 'page', skeleton: 'settings', smoke: false },
  { screen: 'auth', motion: 'page', skeleton: null, smoke: false },
  { screen: 'tools_home', motion: 'page', skeleton: null, smoke: true },
  { screen: 'tool', motion: 'page', skeleton: 'tool', smoke: true },
  { screen: 'account', motion: 'page', skeleton: 'settings', smoke: true },
  { screen: 'admin', motion: 'page', skeleton: 'settings', smoke: false },
  { screen: 'team_lobby', motion: 'page', skeleton: 'lobby', smoke: true },
  { screen: 'team_explorer', motion: 'section', skeleton: 'tiles', smoke: true },
  { screen: 'team_tasks', motion: 'section', skeleton: 'board', smoke: true },
  { screen: 'team_launches', motion: 'section', skeleton: 'list', smoke: true },
  { screen: 'team_accounts', motion: 'section', skeleton: 'list', smoke: true },
  { screen: 'team_members', motion: 'section', skeleton: 'list', smoke: true },
  { screen: 'team_trash', motion: 'section', skeleton: 'list', smoke: false },
  { screen: 'other', motion: 'page', skeleton: null, smoke: false }
];

/**
 * The surfaces that open over a screen rather than replace it. They do not go
 * through the router; each has an appearing and a mirrored closing motion in
 * the inventory (`components/ui/Overlay.tsx`). Listed so the registry covers
 * every moving surface, not only the routed ones.
 */
export const OVERLAY_KINDS = [
  { kind: 'modal', motion: 'surface' },
  { kind: 'drawer', motion: 'edge' },
  { kind: 'popover', motion: 'surface' },
  { kind: 'dropdown_menu', motion: 'surface' },
  { kind: 'toast', motion: 'edge' }
] as const;

/** Paths of the tools — held equal to `tool-registry.ts` by a test. */
export const TOOL_PATHS = [
  '/compressor',
  '/stitcher',
  '/transcription',
  '/landing-optimizer',
  '/2fa',
  '/landing-preview'
] as const;

const TEAM_SECTION_SCREENS: Record<string, ScreenKind> = {
  explorer: 'team_explorer',
  files: 'team_explorer',
  landings: 'team_explorer',
  creatives: 'team_explorer',
  settings: 'team_explorer',
  tasks: 'team_tasks',
  launches: 'team_launches',
  accounts: 'team_accounts',
  members: 'team_members',
  trash: 'team_trash'
};

interface RouteParts {
  pathname: string;
  params: URLSearchParams;
  segments: string[];
}

function parts(route: string): RouteParts {
  const [withoutHash = ''] = route.split('#');
  const queryAt = withoutHash.indexOf('?');
  const pathname = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const search = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1);
  return {
    pathname: pathname || '/',
    params: new URLSearchParams(search),
    segments: pathname.split('/').filter(segment => segment.length > 0)
  };
}

function teamScreen({ segments, params }: RouteParts): ScreenKind | null {
  if (segments[0] !== 'team') return null;
  if (segments.length === 1) return 'team_lobby';
  if (params.get('trash') === '1') return 'team_trash';
  const raw = decodeURIComponent(segments[2] ?? '');
  return TEAM_SECTION_SCREENS[raw] ?? 'team_explorer';
}

/** The screen a route shows. Total: an unknown route is `other`. */
export function screenOf(route: string): ScreenKind {
  const routeParts = parts(route);
  const team = teamScreen(routeParts);
  if (team) return team;
  const { pathname } = routeParts;
  if (pathname === '/') return 'tools_home';
  if (pathname === '/privacy' || pathname === '/terms') return 'public_legal';
  if (pathname === '/login' || pathname.startsWith('/auth/')) return 'auth';
  if (pathname === '/account') return 'account';
  if (pathname === '/admin') return 'admin';
  if ((TOOL_PATHS as readonly string[]).includes(pathname)) return 'tool';
  return 'other';
}

export function registryEntry(screen: ScreenKind): RegistryEntry {
  return MOTION_REGISTRY.find(entry => entry.screen === screen) ?? MOTION_REGISTRY.at(-1)!;
}

/**
 * How moving from one route to another should look.
 *
 * Inside one space: another section (or into/out of the trash) is a
 * `section` move; the same section with a different query — a folder, a
 * filter, an open task, a dialog — is `none`. Elsewhere: the same path with a
 * different query or hash is `none`; a different path is `page`.
 */
export function motionBetween(from: string, to: string): MotionKind {
  const a = parts(from);
  const b = parts(to);
  const aTeam = teamScreen(a);
  const bTeam = teamScreen(b);
  if (aTeam && bTeam && a.segments.length > 1 && b.segments.length > 1) {
    const sameSpace =
      decodeURIComponent(a.segments[1] ?? '') === decodeURIComponent(b.segments[1] ?? '');
    if (!sameSpace) return 'page';
    return aTeam === bTeam ? 'none' : 'section';
  }
  if (a.pathname === b.pathname) return 'none';
  return 'page';
}
