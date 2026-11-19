import { Component } from 'react';

/**
 * Runs `run` when `of` has changed, while the page still shows the old state.
 *
 * An effect runs after the page has been changed, which is too late to look at
 * what was there — where the tiles stood, what the card said. React shows that
 * moment to a class component only (`getSnapshotBeforeUpdate`), so this is one,
 * and it does nothing else: it renders nothing and measures nothing itself.
 * Not called on mount — nothing was there before.
 */
export class BeforeChange extends Component<{ of: unknown; run: () => void }> {
  override getSnapshotBeforeUpdate(previous: Readonly<{ of: unknown }>): null {
    if (!Object.is(previous.of, this.props.of)) this.props.run();
    return null;
  }

  // React asks for this beside `getSnapshotBeforeUpdate`.
  override componentDidUpdate() {}

  override render() {
    return null;
  }
}
