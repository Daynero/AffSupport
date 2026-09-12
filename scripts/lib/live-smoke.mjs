/**
 * What "the deployment actually works" means, as comparisons over responses.
 *
 * The ten-step smoke test in docs/PRODUCTION.md is performed by a person, which
 * means it is performed when a person has the attention to perform it — not at
 * two in the morning after a release, which is exactly when it was needed. Every
 * check here is one a machine can make without credentials, so it can run on
 * every deploy and then every ten minutes forever.
 *
 * The probes themselves live in the gate; these are the judgements, so they can
 * be tested against the responses a broken deployment actually returns rather
 * than the ones a working one does.
 */

/**
 * The failure this exists for: the bundle uploads, the deploy reports success,
 * and the site keeps serving the previous release because the upload went to a
 * different project or the manifest commit never made it into the build.
 *
 * @param {Record<string, any>} live the manifest the site is serving
 * @param {Record<string, any>} local the manifest this release signed
 */
export function manifestAgreement(live, local) {
  const problems = [];
  for (const field of ['version', 'buildId', 'apiVersion', 'minimumSupportedVersion']) {
    if (live?.[field] !== local?.[field])
      problems.push(
        `the served manifest ${field} is ${String(live?.[field])}, this release signed ${String(local?.[field])}`
      );
  }
  const livePlatforms = Object.keys(live?.artifacts ?? {}).sort();
  const localPlatforms = Object.keys(local?.artifacts ?? {}).sort();
  if (livePlatforms.join(',') !== localPlatforms.join(','))
    problems.push(
      `the served manifest offers ${livePlatforms.join(', ') || 'nothing'}, this release signed ${localPlatforms.join(', ')}`
    );
  else
    for (const platform of localPlatforms) {
      if (live.artifacts[platform]?.sha256 !== local.artifacts[platform]?.sha256)
        problems.push(`the served ${platform} digest is not the one this release signed`);
    }
  if (!live?.signature) problems.push('the served manifest carries no signature');
  return problems;
}

/**
 * A Pages project without SPA routing answers 404 to every deep link, so the
 * site works for anyone who lands on `/` and is broken for everyone who has a
 * bookmark. It is invisible from the home page, which is where people look.
 *
 * @param {{status: number, contentType?: string, body?: string}} response
 * @param {string} route
 */
export function spaRouteProblems(response, route) {
  if (response.status !== 200)
    return [`${route} answered HTTP ${response.status}, not the app shell`];
  if (!/text\/html/u.test(response.contentType ?? ''))
    return [`${route} answered ${response.contentType ?? 'no content type'}, not HTML`];
  return [];
}

/**
 * Cloudflare serves its own error pages with HTTP 200 in some failure modes, and
 * a bundle whose script tag is missing renders a white page that looks fine to a
 * status-code check.
 *
 * @param {string} html
 */
export function shellProblems(html) {
  const problems = [];
  if (!/<div id="root"|<div id="app"/u.test(html))
    problems.push('the served page has no application root element');
  if (!/<script[^>]+src="\/assets\//u.test(html))
    problems.push('the served page references no built asset bundle');
  if (/cloudflare|error 1\d{3}/iu.test(html) && !/<div id="root"/u.test(html))
    problems.push('the origin served an edge error page rather than the application');
  return problems;
}

/** The first built asset the shell references, so the gate can prove it loads. */
export function firstAssetPath(html) {
  return /<script[^>]+src="(\/assets\/[^"]+)"/u.exec(html)?.[1] ?? null;
}

/**
 * Sign-in cannot be completed without a real account, but the first hop can be
 * proven: the project must hand the browser to Google with a client id. A
 * project whose provider was switched off answers 400 here, which is the whole
 * of "login does nothing" reported as a number.
 *
 * @param {{status: number, location?: string}} response
 */
export function oauthStartProblems(response) {
  if (response.status !== 302)
    return [`the identity provider handshake answered HTTP ${response.status}, not a redirect`];
  let target;
  try {
    target = new URL(response.location ?? '');
  } catch {
    return ['the identity provider handshake redirected to an unreadable location'];
  }
  const problems = [];
  if (target.hostname !== 'accounts.google.com')
    problems.push(`the identity handshake redirected to ${target.hostname}, not Google`);
  if (!target.searchParams.get('client_id'))
    problems.push('the identity handshake carries no client id');
  return problems;
}

/**
 * Collapses the probe results into one verdict. A probe that could not run at
 * all is a failure, never a skip: an unverifiable deployment is not a verified
 * one, and "could not check" is how a broken smoke test looks exactly like a
 * passing one.
 *
 * @param {readonly {name: string, problems: readonly string[]}[]} checks
 */
export function summarize(checks) {
  const failures = checks.flatMap(check =>
    check.problems.map(problem => `${check.name}: ${problem}`)
  );
  return { ok: failures.length === 0, failures, checked: checks.length };
}
