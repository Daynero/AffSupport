# Contract: адреси одного проду

- `PRODUCTION_SITE_ORIGIN = https://soty.pp.ua`
- `PREVIEW_SITE_ORIGIN = https://next.soty.pp.ua`
- `PREVIEW_BRANCH = next`
- `isSotySiteOrigin(origin)`: true лише для цих двох точних origin.

| Хто | Правило |
|---|---|
| Веб `configuredSiteUrl()` | прод-збірка на одному з двох origin повертає `location.origin`; інакше як раніше |
| Веб `siteChannel()` | `next` на preview origin, `production` на прод origin, `local` інакше |
| Веб, маніфест агента | `${location.origin}/.well-known/wishly/stable.json` на одному з двох origin; інакше `PRODUCTION_SITE_ORIGIN` |
| Агент `allowedOrigins` | + preview, якщо `publicOrigin === PRODUCTION_SITE_ORIGIN` |
| Агент `/pair?origin=` | редірект на `origin`, якщо він в `allowedOrigins`; інакше на `pairOrigin` |
| Edge CORS | + preview, якщо `WISHLY_SITE_URL` — прод-origin |
| Drive OAuth callback | повернення на `transaction.origin`, якщо він дозволений CORS; інакше `WISHLY_SITE_URL` |
| Supabase Auth | redirect allow list має `https://next.soty.pp.ua/**` |
| Google Picker key | referrer `https://next.soty.pp.ua/*` |
