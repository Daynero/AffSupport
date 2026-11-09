# Real Google provider acceptance — 2026-11-05

Only private synthetic fixtures owned by this test were changed. Fixture cells contained fixed synthetic IDs and example.invalid URLs. No existing catalog was changed. All fixture folders/sheets were moved to trash after checking the ownership nonce. OAuth credentials remained in process and are absent from these reports. Local beta project: r2beta045.

## Export and public link: passed

`provider-export-report.json` proves native Google Sheet → XLSX through the candidate export client. The returned ZIP contains the XLSX workbook/worksheet structure, has an .xlsx name, and remains downloadable anonymously after creation of an anyone-reader permission. A second permission request reuses the existing permission. This validates provider behavior, not the full beta UI or deployed Functions endpoint.

## Conditional content replacement: failed

Three actual upload methods were tested: v2 multipart, media, and resumable. For multipart and media, the matching ETag updated the actual cells. A stale ETag returned HTTP 412 but the cells still changed to MUST_NOT_APPLY. Actual cells were checked with the Sheets API over bounded reads, not only through a cached Drive export. The resumable path also changed cells despite a 412 response. All outcomes are known and fixtures were trashed; sanitized reports accompany this review.

The contract C5/T031 requirement that a stale conditional upload cannot change content is therefore not satisfied. It would be incorrect to treat HTTP 412 as proof that no mutation occurred. At this probe stage no new variation/delayed-link writer or associated writer schema had been introduced on this assumption. The then-pending choice (resolved by the clarification below) was: Soty owns the video cells of the same Sheet, or each publication creates a distinct Sheet. Independent reliability fixes continue.

Provider references: https://developers.google.com/workspace/drive/api/reference/rest/v2/files/update and https://developers.google.com/workspace/drive/api/guides/manage-uploads . The observation above is an empirical fixture result, not a claim made by these documents.


## Owner clarification, 2026-11-08

The earlier ownership-choice question is resolved: keep the same existing table
and URL and update only video-link cells at due; no new catalog or ownership
requirement for user IDs. The failed full-media412 evidence above remains valid
and forbids that old writer. A narrow Sheets UpdateCells + atomic receipt writer
is being implemented. It is not external-cell CAS. Real-provider video-only,
nonvideo-preservation, timing and unknown-ACK acceptance is still pending; mocked
request tests do not constitute provider acceptance.
