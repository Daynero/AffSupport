import {
  CATALOG_FILTER_KEYS,
  normalizeCatalogSearchRequest,
  type CatalogFilterKey,
  type CatalogSearchFilters
} from '@video-compressor/shared';

export const TEAM_SECTIONS = [
  'files',
  'tasks',
  'creatives',
  'landings',
  'settings',
  'trash'
] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];

/** Files is canonical and carries no path suffix: `/team/<id>` *is* Files. */
export const DEFAULT_SECTION: TeamSection = 'files';

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
  /** Files browser position. */
  folderId: string | null;
}

export type TeamRoute =
  | { kind: 'resolver'; driveReturn: string | null }
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
  return { q: '', filters: emptyFilters(), taskId: null, folderId: null };
}

function isSection(value: string): value is TeamSection {
  return (TEAM_SECTIONS as readonly string[]).includes(value);
}

function trimmedParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)?.trim();
  return value ? value : null;
}

/**
 * Parse any in-app route into a team address.
 *
 * Total by construction: it never throws and never rejects. A path outside
 * `/team` returns `null`; anything inside it resolves to a route, because a
 * pasted link with a typo should land somewhere explainable rather than on an
 * error. An unrecognized section degrades to Files, and an unrecognized space
 * id is carried through verbatim so the resolver's own access check renders the
 * one neutral no-access screen (it must not distinguish "absent" from "denied").
 */
export function parseTeamRoute(route: string): TeamRoute | null {
  const [pathAndQuery = ''] = route.split('#');
  const [pathname = '', search = ''] = splitOnce(pathAndQuery, '?');
  const segments = pathname.split('/').filter(segment => segment.length > 0);
  if (segments[0] !== 'team') return null;

  const params = new URLSearchParams(search);
  if (segments.length === 1) {
    return { kind: 'resolver', driveReturn: trimmedParam(params, 'drive') };
  }

  const spaceId = decodeURIComponent(segments[1] ?? '');
  const rawSection = decodeURIComponent(segments[2] ?? '');
  const section = isSection(rawSection) ? rawSection : DEFAULT_SECTION;
  return {
    kind: 'space',
    spaceId,
    section,
    query: {
      q: params.get('q')?.trim() ?? '',
      filters: readFilters(params),
      taskId: trimmedParam(params, 'task'),
      folderId: trimmedParam(params, 'folder')
    }
  };
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
 * not carry a catalog filter, a Files link does not carry an open task — so the
 * same view always has one address and Back never walks through near-duplicates.
 */
export function buildTeamRoute(input: TeamRouteInput): string {
  const section = input.section ?? DEFAULT_SECTION;
  const path =
    section === DEFAULT_SECTION ? `/team/${input.spaceId}` : `/team/${input.spaceId}/${section}`;
  const params = new URLSearchParams();
  const query = input.query ?? {};

  if (section === 'files') {
    const q = query.q?.trim();
    if (q) params.set('q', q);
    const filters = query.filters;
    if (filters) {
      for (const key of CATALOG_FILTER_KEYS) {
        for (const value of filters[key]) params.append(FILTER_PARAM[key], value);
      }
    }
    if (query.folderId) params.set('folder', query.folderId);
  }
  if (section === 'tasks' && query.taskId) params.set('task', query.taskId);

  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** The bare resolver address (`/team`), where entry decisions are made. */
export function teamResolverRoute(): string {
  return '/team';
}
