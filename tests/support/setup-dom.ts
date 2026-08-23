import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts anything a DOM test rendered, after every test.
 *
 * Testing Library does not do this on its own unless the runner is configured for it, and
 * fourteen of the sixty-four component test files never called `cleanup` themselves. Those
 * files left their trees mounted, so the next test in the same file queried a document
 * containing several renders at once — which is how a passing assertion can be matching an
 * element the test under consideration never created.
 *
 * Registering it here rather than per-file makes it impossible to forget in a new test.
 * It is a no-op in the node environment, where nothing was rendered.
 */
afterEach(() => {
  cleanup();
});
