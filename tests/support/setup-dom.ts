import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts anything a DOM test rendered, and returns the address to `/`, after
 * every test.
 *
 * Testing Library does not do this on its own unless the runner is configured for it, and
 * fourteen of the sixty-four component test files never called `cleanup` themselves. Those
 * files left their trees mounted, so the next test in the same file queried a document
 * containing several renders at once — which is how a passing assertion can be matching an
 * element the test under consideration never created.
 *
 * Registering it here rather than per-file makes it impossible to forget in a new test.
 * It is a no-op in the node environment, where nothing was rendered.
 *
 * The address is reset for the same reason. jsdom keeps one `window.location`
 * for a whole file, so a test that navigates — which any test touching team
 * mode now does, since the URL is what decides which space and section are open
 * — leaves the next test starting from that address. The symptom is a test
 * failing on a screen it never asked for.
 */
afterEach(() => {
  cleanup();
  if (typeof window !== 'undefined' && window.location.pathname !== '/') {
    window.history.replaceState(null, '', '/');
  }
});
