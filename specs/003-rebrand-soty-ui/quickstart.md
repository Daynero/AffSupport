# Quickstart: Validate the Isolated Soty Review

This guide describes the commands and evidence the implementation must provide. It does not
authorize production integration.

## Prerequisites

- Node.js 22 and repository dependencies installed.
- Review workspace implemented according to [isolation-boundary.md](./contracts/isolation-boundary.md).
- Synthetic fixtures only; no production `.env`, account or data export.

## 1. Start the local review

```bash
npm run dev:soty-review
```

Expected: only `http://127.0.0.1:5174` is served. Open `/#/catalog`; the header shows the
iteration ID and catalog completeness. Refreshing a screen/state hash preserves the view;
an invalid screen/state returns to catalog with an explanation.

## 2. Run static and unit gates

```bash
npm run format:check
npm run lint
npm test
npm run build:web
npm run build:soty-review
```

Expected:

- catalog IDs are unique and every canonical state is scenario or justified N/A;
- route parser and reducer are exhaustive and reject unknown input safely;
- token generation has no unresolved/cyclic aliases, stale output or forbidden primitive
  literals;
- forbidden production imports and browser/network/storage globals are absent;
- production web still builds and contains no Soty review marker.

## 3. Prove runtime isolation and capture evidence

```bash
npm run verify:soty-review
```

Expected:

- at least 50 demo actions execute with zero external, Supabase, API, analytics or agent
  requests;
- only review-origin static/HMR traffic is observed;
- axe reports zero serious/critical violations (manual WCAG verification still required);
- screenshots are deterministically named by iteration/surface/state/theme/viewport;
- light/dark and reduced-motion scenarios complete with no document-level horizontal
  overflow or decoration covering content/focus/actions.

## 4. Manual visual and usability review

Use [review-catalog.md](./contracts/review-catalog.md) and record each result under the
stable review key.

1. Check all catalog surfaces/states in light and dark themes.
2. Complete representative flows only by keyboard; verify visible focus and modal return.
3. Test real browser zoom at 200% on at least 1280x720 and 1440x900 windows.
4. Check Ukrainian plus long English/file/team/person fixtures.
5. Confirm one dominant honey action, progressive disclosure and visible consequences.
6. Verify honeycomb/bee/honey never behaves like a control or obscures content.
7. Run the moderated timing tests for SC-004–SC-006 and record participant outcomes.

## 5. Approval gate

The owner reviews the evidence matrix described in
[visual-system-and-approval.md](./contracts/visual-system-and-approval.md). Until written
approval covers both themes, responsive/zoom states, logo direction and all blocking notes:

- feature remains review-only and inactive;
- do not import it into `apps/web`;
- do not connect auth, data, agent, analytics or storage;
- do not deploy, package, release or update product manifests;
- do not start functional integration planning.

