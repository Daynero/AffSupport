/**
 * What a live project must look like, expressed as comparisons over plain data.
 *
 * The remote calls belong to the gate; the judgements belong here, where they
 * can be tested against the awkward shapes a real project produces — a function
 * that exists but is not ACTIVE, a migration applied remotely that no longer
 * exists locally, an allow-list entry that quietly widens to a wildcard.
 *
 * Nothing in this module reads a secret value. Presence is the only fact worth
 * checking and the only one safe to report.
 */

export function missingSecrets(required, present) {
  const available = new Set(present);
  return required.filter(name => !available.has(name));
}

/**
 * Secrets the project carries that nothing in this repository declares.
 *
 * Not a failure: the platform injects several of its own, and an operator may
 * have set something for a service outside this codebase. It is reported so a
 * leftover from a deleted feature is visible rather than invisible.
 */
export function undeclaredSecrets(declared, present) {
  const known = new Set(declared);
  return present.filter(name => !known.has(name) && !name.startsWith('SUPABASE_')).sort();
}

/**
 * @param {readonly string[]} declared function directories in this repository
 * @param {readonly {slug: string, status?: string, version?: number}[]} deployed
 */
export function functionParity(declared, deployed) {
  const live = new Map(deployed.map(entry => [entry.slug, entry]));
  return {
    // A function in the repository that the project has never seen. Every
    // feature behind it answers 404 to a client that expects it to exist.
    missing: declared.filter(slug => !live.has(slug)).sort(),
    // Deployed but not ACTIVE: it will not serve, and nothing local says so.
    inactive: declared
      .filter(slug => {
        const entry = live.get(slug);
        return entry !== undefined && entry.status !== 'ACTIVE';
      })
      .sort(),
    // Deployed from a repository state that no longer exists here. Harmless to
    // run, informative to see: it is usually a function somebody renamed.
    undeclared: [...live.keys()].filter(slug => !declared.includes(slug)).sort()
  };
}

/**
 * @param {readonly {local?: string, remote?: string}[]} entries as `supabase migration list` reports them
 * @param {readonly string[]} [expectedPending] migrations this release declares it will apply
 */
export function migrationDrift(entries, expectedPending = []) {
  const expected = new Set(expectedPending);
  const localOnly = entries.flatMap(entry => (entry.local && !entry.remote ? [entry.local] : []));
  return {
    // Written here, never applied there. Any code that assumes the new shape is
    // already broken in production; the release just has not shipped it yet.
    unapplied: localOnly.filter(version => !expected.has(version)).sort(),
    // Declared by this release, so its presence is the plan working rather than
    // drift. Reported separately so the two are never confused.
    planned: localOnly.filter(version => expected.has(version)).sort(),
    // Applied there, absent here. The database has a shape this repository
    // cannot reproduce, which makes every local rehearsal a different database.
    untracked: entries.flatMap(entry => (entry.remote && !entry.local ? [entry.remote] : [])).sort()
  };
}

/**
 * The sign-in round trip, which is the failure users describe as "login does
 * nothing": the redirect comes back to an origin the project does not accept
 * and the session is dropped without an error anyone sees.
 *
 * @param {{siteUrl?: string, allowList?: string}} config
 * @param {string} expectedOrigin
 */
export function authProblems(config, expectedOrigin) {
  const problems = [];
  const siteUrl = (config.siteUrl ?? '').replace(/\/$/, '');
  if (siteUrl !== expectedOrigin)
    problems.push(`Supabase Site URL is ${siteUrl || 'unset'}, not ${expectedOrigin}`);

  const entries = (config.allowList ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  const callback = `${expectedOrigin}/auth/callback`;
  if (!entries.includes(callback))
    problems.push(`the redirect allow-list does not contain ${callback}`);

  // A wildcard that covers the production origin lets any subdomain or path
  // receive a real session. docs/PRODUCTION.md refuses them for preview URLs
  // for exactly this reason; a gate is more reliable than the paragraph.
  const wildcards = entries.filter(entry => entry.includes('*'));
  if (wildcards.length)
    problems.push(`the redirect allow-list contains wildcards: ${wildcards.join(', ')}`);

  return problems;
}

/**
 * The one cross-surface identity that no single check owns: the origin the
 * browser bundle was built for, the origin the functions accept, and the origin
 * the release binding names must be the same string.
 */
export function originAgreement({ binding, webSiteUrl, functionSiteUrl }) {
  const problems = [];
  const normalise = value => (value ?? '').replace(/\/$/, '');
  if (normalise(webSiteUrl) !== binding)
    problems.push(
      `the web bundle targets ${normalise(webSiteUrl) || 'nothing'}, the binding is ${binding}`
    );
  if (functionSiteUrl !== undefined && normalise(functionSiteUrl) !== binding)
    problems.push(
      `the functions' WISHLY_SITE_URL is ${normalise(functionSiteUrl) || 'unset'}, the binding is ${binding}`
    );
  return problems;
}
