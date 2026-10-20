# Validation guide

1. Prepare a local beta space with 1, 40, 400 and 500 catalogs. Record existing intervals, next runs and effective global change settings before migration.
2. Apply migration locally. Confirm each existing catalog retains interval, next run and change behavior. Create a new catalog and confirm template initialization.
3. Configure A hourly with images, B daily with texts, C off. Reload, inspect each row and run due work; verify only its selected changes occur and all sheets retain their links.
4. Trigger manual work on C and confirm C remains off; trigger it twice and confirm one active attempt. Check last success, last failure and next run separately.
5. Simulate Drive timeout after write, agent offline/stale during restitch, stale profile write, failed refresh after initial load, and partial table/video result. Confirm table delivery proceeds when the agent is blocked, safe retry, accurate user state and CLI diagnosis.
6. Test selection under filters, mixed bulk values, search/scroll while progress arrives, narrow width, keyboard, screen reader and reduced motion. Include both the profile and bulk editors: mixed, conflict, pending, per-item failure, focus return and announcements. Include a row with an older success and newer failure at 390 px, with both exact times reachable.
7. Run an unprompted usability session with 10 representative buyers. Give each the same two tasks from SC-001 and SC-002; time each task, record wrong changes and whether help was needed, and require at least 9/10 to pass each stated threshold. Store anonymous observations and pass/fail in `acceptance.md`. Until this gate passes, UX acceptance is pending.
8. Run focused single-worker Vitest and database tests for affected paths, then `npm run verify` and relevant release gates before shipping. Run beta packaged verification for the exact release commit before production.
