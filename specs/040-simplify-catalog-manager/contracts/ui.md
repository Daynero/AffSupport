# UI contract

List: full identity disclosure, last confirmed success, visible schedule/next run; five independent inline toggle buttons, video first; Update now and overflow. Configure opens live details. History in overflow. Search and Filters; filter fields visibly labelled. One list scroll. Defaults link in screen overflow routes to space catalog settings.

Profile: catalog heading remains visible; When and What are the same live controls as the row, with immediate one-field persistence and versioned undo. Pending writes block execution; unknown/conflict recovery is accessible inside details. Parent navigation respects pending state and bulk drafts; no key based on profile version.

Bulk: selection only reveals compact toolbar, explicit Configure opens form, mixed/keep/off distinct; partial results preserved.

API: existing listCatalogUpdateProfiles, patchCatalogUpdateProfile expectedVersion, run/cancel/retry and history endpoints retained. Defaults setters limited to future catalogs. Success requires confirmed server outcome; absent evidence remains unknown.
