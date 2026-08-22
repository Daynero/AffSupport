// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const site = { current: 'https://soty.pp.ua' };
const agent = { current: 'http://127.0.0.1:43120' };

vi.mock('../apps/web/src/lib/config', () => ({
  configuredSiteUrl: () => site.current,
  configuredAgentOrigin: () => agent.current,
  servedByAgent: (origin: string = location.origin) => origin === agent.current
}));

const {
  HANDOFF_PATH,
  allowedHandoffReturn,
  claimHandoffAttempt,
  declineHandoff,
  handoffDeliveryUrl,
  handoffRequestUrl,
  releaseHandoffAttempts,
  safeNext,
  sessionHandoffOrigin,
  takeDeliveredSession
} = await import('../apps/web/src/auth/session-handoff');

/** jsdom cannot change origin, so tests state which origin they are speaking as. */
function speakingAsTheAgentCopy() {
  agent.current = location.origin;
}

function speakingAsTheWebsite() {
  agent.current = 'http://127.0.0.1:43120';
}

describe('carrying one sign-in from the website into the Agent copy', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/');
    site.current = 'https://soty.pp.ua';
    speakingAsTheWebsite();
  });

  it('asks the website only from the Agent copy, and only when it is elsewhere', () => {
    expect(sessionHandoffOrigin()).toBe(null);

    speakingAsTheAgentCopy();
    expect(sessionHandoffOrigin()).toBe('https://soty.pp.ua');

    // A beta package serves the site and the Agent from one origin: there is no
    // second storage area to fetch a session from, and asking would be a
    // redirect to ourselves.
    site.current = location.origin;
    expect(sessionHandoffOrigin()).toBe(null);
    expect(handoffRequestUrl('/compressor')).toBe(null);
  });

  it('names itself and where it wants to land when it asks', () => {
    speakingAsTheAgentCopy();

    const url = new URL(handoffRequestUrl('/compressor')!);

    expect(url.origin).toBe('https://soty.pp.ua');
    expect(url.pathname).toBe(HANDOFF_PATH);
    expect(url.searchParams.get('returnTo')).toBe(location.origin);
    expect(url.searchParams.get('next')).toBe('/compressor');
  });

  it('hands a session to this installation Agent and to nothing else', () => {
    expect(allowedHandoffReturn('http://127.0.0.1:43120')).toBe('http://127.0.0.1:43120');
    expect(allowedHandoffReturn('http://127.0.0.1:43120/pair')).toBe('http://127.0.0.1:43120');

    // Everything below would be a live session delivered to someone else.
    expect(allowedHandoffReturn('https://evil.example')).toBe(null);
    expect(allowedHandoffReturn('http://evil.example')).toBe(null);
    expect(allowedHandoffReturn('http://127.0.0.1:8080')).toBe(null);
    expect(allowedHandoffReturn('http://127.0.0.1.evil.example')).toBe(null);
    expect(allowedHandoffReturn('javascript:alert(1)')).toBe(null);
    expect(allowedHandoffReturn('//127.0.0.1:43120')).toBe(null);
    expect(allowedHandoffReturn('')).toBe(null);
    expect(allowedHandoffReturn(null)).toBe(null);
  });

  it('sends the session in the fragment, which never reaches a server', () => {
    const url = new URL(
      handoffDeliveryUrl(
        'http://127.0.0.1:43120',
        { access_token: 'access-value', refresh_token: 'refresh-value' },
        '/account'
      )
    );

    expect(url.search).toBe('');
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get('access_token')).toBe('access-value');
    expect(fragment.get('refresh_token')).toBe('refresh-value');
    expect(fragment.get('next')).toBe('/account');
  });

  it('takes the delivered session and leaves no trace in the address bar', () => {
    history.replaceState(null, '', `${HANDOFF_PATH}#access_token=a&refresh_token=r&next=/account`);

    const delivered = takeDeliveredSession();

    expect(delivered).toEqual({ accessToken: 'a', refreshToken: 'r', next: '/account' });
    expect(location.hash).toBe('');
    expect(location.pathname).toBe(HANDOFF_PATH);
  });

  it('reports no session rather than half of one', () => {
    history.replaceState(null, '', `${HANDOFF_PATH}#access_token=a`);

    expect(takeDeliveredSession()).toBe(null);
    expect(location.hash).toBe('');
  });

  it('will not be talked into landing anywhere but inside the app', () => {
    // `next` comes back from another origin, so treating it as a URL would make
    // the app a redirector for whoever set it.
    expect(safeNext('/compressor')).toBe('/compressor');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
    // And never back into the exchange itself, which would loop.
    expect(safeNext(HANDOFF_PATH)).toBe('/');
    expect(safeNext('/auth/callback?code=1')).toBe('/');
  });

  it('asks twice on its own, then hands the decision to the user', () => {
    expect(claimHandoffAttempt()).toBe(true);
    expect(claimHandoffAttempt()).toBe(true);
    expect(claimHandoffAttempt()).toBe(false);

    releaseHandoffAttempts();
    expect(claimHandoffAttempt()).toBe(true);
  });

  it('stops asking once the user has signed out, until they ask to sign in', () => {
    // Otherwise signing out in the app would be undone immediately: the next ask
    // finds the website session still live and signs the user back in.
    declineHandoff();

    expect(claimHandoffAttempt()).toBe(false);
    // Durable, because "Open Soty" opens a new tab every time.
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.getItem('wishly.auth.handoff-declined.v1')).toBe('1');

    releaseHandoffAttempts();
    expect(claimHandoffAttempt()).toBe(true);
  });
});
