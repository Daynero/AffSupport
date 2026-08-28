import {
  CATALOG_FILTER_KEYS,
  TEAM_MATERIAL_ROW_KINDS,
  normalizeCatalogSearchRequest,
  type CatalogFilterKey,
  type CatalogSearchFilters,
  type TeamMaterialRowKind
} from '@video-compressor/shared';

/**
 * The three destinations a space has (011, FR-029): the explorer, tasks and
 * members. Everything the old Files, Landings, Creatives, Settings and Trash
 * screens did is a view or a dialog of the explorer now; their old addresses
 * still resolve, as aliases, so a pasted link keeps meaning what it meant.
 */
export const TEAM_SECTIONS = ['explorer', 'tasks', 'members'] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];

/** The explorer is canonical and carries no path suffix: `/team/<id>` *is* it. */
export const DEFAULT_SECTION: TeamSection = 'explorer';

export type ExplorerView = 'grid' | 'list';

/**
 * The query half of a team address. Every field is restorable on refresh, so
 * this is the whole of the view state the URL is responsible for.
 */
export interface TeamRouteQuery {
  /** Catalog search text; '' when absent. */
  q: string;
  filters: CatalogSearchFilters;
  /** Opens the task editor over the Tasks section. */
  taskId: string | null;
  /** Explorer position: the open folder's provider id, null for the root. */
  folderId: string | null;
  /** Explorer kind filters; empty for all. */
  kinds: TeamMaterialRowKind[];
  /** Tiles or rows; null leaves it to the remembered choice. */
  view: ExplorerView | null;
  /** Whether a search looks in the open folder or the whole space. */
  scope: 'folder' | 'space';
  /** The explorer shows the trash instead of a folder. */
  trash: boolean;
  /** The space settings dialog is open over the explorer. */
  settings: boolean;
  /** The selected material, so a shared link opens on it. */
  itemId: string | null;
}

export type TeamRoute =
  | {
      kind: 'resolver';
      driveReturn: string | null;
      /**
       * "Show me every space", asked for out loud. Without it `/team` is a
       * question the resolver answers by *entering* somewhere — one ready
       * space, or the remembered one — which is right for arriving at `/team`
       * and wrong for having just pressed "All spaces".
       */
      showAll: boolean;
    }
  | { kind: 'space'; spaceId: string; section: TeamSection; query: TeamRouteQuery };

/**
 * URL parameter names, kept short and readable because these end up in links
 * people paste to each other. `language`/`originalType` are the only two that
 * differ from their filter key.
 */
const FILTER_PARAM: Record<CatalogFilterKey, string> = {
  geo: 'geo',
  language: 'lang',
  offer: 'offer',
  category: 'category',
  originalType: 'type',
  kind: 'kind',
  unfilled: 'unfilled'
};

/** Explorer kind chips use `k`; the catalog's older `kind` filter keeps `kind`. */
const KINDS_PARAM = 'k';

/**
 * Filters are repeated params (`?geo=US&geo=DE`) rather than a comma-joined
 * list because `offer` is free text and may legitimately contain a comma.
 */
function readFilters(params: URLSearchParams): CatalogSearchFilters {
  const raw: Record<string, string[]> = {};
  for (const key of CATALOG_FILTER_KEYS) {
    const values = params.getAll(FILTER_PARAM[key]).filter(value => value.length > 0);
    if (values.length > 0) raw[key] = values;
  }
  // The shared normalizer is the single validator for filter values, so a
  // hand-edited URL cannot smuggle a value the search request would reject.
  // Anything it refuses degrades to "no filters" rather than to an error page.
  const normalized = normalizeCatalogSearchRequest({ filters: raw });
  return normalized?.filters ?? emptyFilters();
}

function emptyFilters(): CatalogSearchFilters {
  return {
    geo: [],
    language: [],
    offer: [],
    category: [],
    originalType: [],
    kind: [],
    unfilled: []
  };
}

export function emptyTeamRouteQuery(): TeamRouteQuery {
  return {
    q: '',
    filters: emptyFilters(),
    taskId: null,
    folderId: null,
    kinds: [],
    view: null,
    scope: 'folder',
    trash: false,
    settings: false,
    itemId: null
  };
}

function isSection(value: string): value is TeamSection {
  return (TEAM_SECTIONS as readonly string[]).includes(value);
}

function isRowKind(value: string): value is TeamMaterialRowKind {
  return (TEAM_MATERIAL_ROW_KINDS as readonly string[]).includes(value);
}

function trimmedParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)?.trim();
  return value ? value : null;
}

function readKinds(params: URLSearchParams): TeamMaterialRowKind[] {
  const seen = new Set<TeamMaterialRowKind>();
  for (const raw of params.getAll(KINDS_PARAM)) {
    for (const piece of raw.split(',')) {
      const kind = piece.trim();
      if (isRowKind(kind)) seen.add(kind);
    }
  }
  return [...seen];
}

/**
 * The old sections, kept as aliases (011). A link to `/landings` opens the
 * explorer filtered to landings; `/settings` opens the explorer with the
 * settings dialog; `/trash` the explorer's trash view; `/files` the explorer.
 */
function aliasSection(
  raw: string,
  query: TeamRouteQuery
): { section: TeamSection; query: TeamRouteQuery } {
  switch (raw) {
    case 'files':
      return { section: 'explorer', query };
    case 'landings':
      return {
        section: 'explorer',
        query: { ...query, kinds: ['landing'], view: query.view ?? 'grid' }
      };
    case 'creatives':
      return {
        section: 'explorer',
        query: { ...query, kinds: ['image', 'video'], view: query.view ?? 'grid' }
      };
    case 'settings':
      return { section: 'explorer', query: { ...query, settings: true } };
    case 'trash':
      return { section: 'explorer', query: { ...query, trash: true } };
    default:
      return { section: isSection(raw) ? raw : DEFAULT_SECTION, query };
  }
}

/**
 * Parse any in-app route into a team address.
 *
 * Total by construction: it never throws and never rejects. A path outside
 * `/team` returns `null`; anything inside it resolves to a route, because a
 * pasted link with a typo should land somewhere explainable rather than on an
 * error. An unrecognized section degrades to the explorer, and an unrecognized
 * space id is carried through verbatim so the resolver's own access check
 * renders the one neutral no-access screen (it must not distinguish "absent"
 * from "denied").
 */
export function parseTeamRoute(route: string): TeamRoute | null {
  const [pathAndQuery = ''] = route.split('#');
  const [pathname = '', search = ''] = splitOnce(pathAndQuery, '?');
  const segments = pathname.split('/').filter(segment => segment.length > 0);
  if (segments[0] !== 'team') return null;

  const params = new URLSearchParams(search);
  if (segments.length === 1) {
    return {
      kind: 'resolver',
      driveReturn: trimmedParam(params, 'drive'),
      showAll: params.get('all') === '1'
    };
  }

  const spaceId = decodeURIComponent(segments[1] ?? '');
  const rawSection = decodeURIComponent(segments[2] ?? '');
  const rawView = params.get('view');
  const base: TeamRouteQuery = {
    q: params.get('q')?.trim() ?? '',
    filters: readFilters(params),
    taskId: trimmedParam(params, 'task'),
    folderId: trimmedParam(params, 'folder'),
    kinds: readKinds(params),
    view: rawView === 'grid' || rawView === 'list' ? rawView : null,
    scope: params.get('scope') === 'space' ? 'space' : 'folder',
    trash: params.get('trash') === '1',
    settings: params.get('settings') === '1',
    itemId: trimmedParam(params, 'item')
  };
  const { section, query } = aliasSection(rawSection, base);
  return { kind: 'space', spaceId, section, query };
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, ''];
  return [value.slice(0, index), value.slice(index + 1)];
}

export interface TeamRouteInput {
  spaceId: string;
  section?: TeamSection;
  query?: Partial<TeamRouteQuery>;
}

/**
 * Build the canonical address for a space view.
 *
 * Query state is dropped where the section cannot act on it — a Tasks link does
 * not carry a catalog filter, an explorer link does not carry an open task — so
 * the same view always has one address and Back never walks through
 * near-duplicates.
 */
export function buildTeamRoute(input: TeamRouteInput): string {
  const section = input.section ?? DEFAULT_SECTION;
  const path =
    section === DEFAULT_SECTION ? `/team/${input.spaceId}` : `/team/${input.spaceId}/${section}`;
  const params = new URLSearchParams();
  const query = input.query ?? {};

  if (section === 'explorer') {
    const q = query.q?.trim();
    if (q) params.set('q', q);
    const filters = query.filters;
    if (filters) {
      for (const key of CATALOG_FILTER_KEYS) {
        for (const value of filters[key]) params.append(FILTER_PARAM[key], value);
      }
    }
    if (query.folderId) params.set('folder', query.folderId);
    if (query.kinds && query.kinds.length > 0) params.set(KINDS_PARAM, query.kinds.join(','));
    if (query.view) params.set('view', query.view);
    if (query.scope === 'space') params.set('scope', 'space');
    if (query.trash) params.set('trash', '1');
    if (query.settings) params.set('settings', '1');
    if (query.itemId) params.set('item', query.itemId);
  }
  if (section === 'tasks' && query.taskId) params.set('task', query.taskId);

  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * The resolver address (`/team`), where entry decisions are made.
 *
 * `showAll` puts the intent in the address rather than in component state,
 * which is the same rule the rest of team mode follows: the URL is the truth
 * about what is open. It also means refreshing the lobby keeps you in the
 * lobby instead of dropping you back into a space.
 */
export function teamResolverRoute(options: { showAll?: boolean } = {}): string {
  return options.showAll ? '/team?all=1' : '/team';
}
