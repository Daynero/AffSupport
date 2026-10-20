# Buyer review — round 1

Date: 2026-10-18. Independent reviewer: buyer. Environment: local beta `127.0.0.1:5175`, test workspace `22222222-2222-4222-8222-222222222222`, real beta fixture login. Browser: dedicated Chrome tab 766198362.

## Score: 45/100 — blocked, not accepted

This is a score of the observable usable implementation in this round. The daily financial workflow could not be completed, so untested scenarios do not receive assumed passing credit. It is not evidence that every untested feature is broken.

## Evidence and ordered fixes

1. **P0 — beta becomes unbootable after refresh.** After accounts opened and test mutations were attempted, a reload resulted in `?boot-recovery=mvcz1zcv` and the full-page message “Soty не вдалося запустити / Оновіть сторінку, щоб завантажити актуальну версію.” Screenshot captured in browser review tool output. No captured console error. This blocks persistence verification and the rest of the buyer day.
2. **P1 — social creation appears failed although row later exists.** Click Add account, enter `BUYER038`, Save. Form remained available; another Save produced “Не вдалося зберегти. Спробуйте ще раз.”, while `BUYER038` later appeared in the table. Parent reports parse/double-submit fixes applied during review; retest required. Honest success/pending feedback is essential before money is entered.
3. **P1 — new RK pending, then parent group disappears.** In `BUYER038`, Add RK `88003801` without launch, Save. Save became disabled and stayed pending across several observations (~20+ seconds); parent still said “Немає РК”. Later the entire `BUYER038` group disappeared and a “Живі оновлення не надходять — підключити знову” message appeared. No reset was expected. Determine mutation outcome and retain reliable visible result before acceptance.
4. **P2 — creation scroll reveals insufficient working context.** At default 1384×666 viewport, auto-scrolling the create form left its left side clipped by horizontal table scroll and pushed section context offscreen. Captured screenshot shows a partially clipped social creation input/error and financial headers occupying the lower row region. Recheck after final unified table sizing; avoid user needing to recover horizontal position to understand a save failure.

## Positively observed

- Single surface has no internal Accounts/Finances tabs.
- Today, yesterday, current/previous month, Excel, and copy-topup controls are exposed together.
- Per-RK balance, yesterday spend, today topup, today spend, history, launch assignment, archive, and manual move commands are present.
- Time zone and currency are explicitly visible (`USD · Europe/Kiev`).
- Main archive access is behind secondary actions; RK archive action exists.

## Not yet verified (must retest)

Five-RK column entry with Enter/Shift+Enter; separate yesterday/today saving and totals; reload persistence; clipboard payload; independent collapse retention; explicit-zero archive retention; archive without today data; historical correction; restore parent/child independence; manual order persistence and long-press gesture; conflict/lost response; launch preservation.

No product source files were modified by this reviewer. Only local test data were submitted through the UI.
