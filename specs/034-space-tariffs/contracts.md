# Контракти: тарифи на простір

Усі ключі JSON — camelCase. Дати — `YYYY-MM-DD` (київська дата), моменти — ISO 8601 UTC. `state` тарифу:
`internal | legacy | active | expiring | grace | blocked | none | pending | pending_expired` (`pending*` — лише в адмінці:
видача на пошту без акаунта / без простору). Помилки — `raise exception '<CODE>' using errcode=…` з кодами плану (R15) і
наявними (`PERMISSION_DENIED`, `NOT_FOUND`, `INVALID_INPUT`).

## Спільні об'єкти

```ts
type TariffPlan = {
  code: string;
  nameUk: string;
  nameEn: string;
  summaryUk: string;
  summaryEn: string;
  baseSeats: number;
  invitesAllowed: boolean;
  extraSeatsAllowed: boolean;
  maxExtraSeats: number | null;
  billingPeriod: string | null;
  highlight: boolean;
  features: string[];
  showcase: boolean;
  sortOrder: number;
};
type AdminContact = { telegram: string | null; email: string | null }; // telegram — логін без @
type TeamTariff = {
  // get_team_tariff і елементи get_my_space_access.teams[].tariff
  state: 'internal' | 'legacy' | 'active' | 'expiring' | 'grace' | 'blocked' | 'none';
  planCode: string | null;
  planNameUk: string | null;
  planNameEn: string | null;
  seatsTotal: number;
  seatsUsed: number;
  pendingInvites: number;
  canInvite: boolean;
  endsOn: string | null;
  endsAt: string | null;
  graceUntil: string | null;
  daysLeft: number | null;
  isOwner: boolean;
  updaterPausedByTariff: boolean;
  // лише власнику (інакше null): endsOn/endsAt/graceUntil/daysLeft лишаються, planName — теж
};
```

## Клієнт

### `get_my_space_access() → jsonb`

```ts
{
  mode: 'workspace' | 'blocked' | 'showcase';
  canCreate: boolean;                    // є чинний неприв'язаний тариф і власного активного простору під нього ще немає
  pendingTariff: { planCode: string; planNameUk: string; planNameEn: string; endsOn: string } | null; // для майстра створення
  teams: Array<{ teamId: string; name: string; role: string; accessState: 'allowed'|'blocked';
                 ownerName: string | null; tariff: TeamTariff }>;   // усі активні членства, включно з призупиненими
  invitations: Array<{ invitationId: string; teamId: string; teamName: string; inviterName: string | null;
                       role: string; blocked: boolean }>;           // чинні pending-запрошення на пошту користувача
  banner: null | { teamId: string; teamName: string; kind: 'warn_3d'|'warn_1d'|'grace';
                   endsOn: string; graceUntil: string; daysLeft: number; updaterRunning: boolean; planCode: string };
  toast: null | { teamId: string; kind: 'renewed'|'granted'; endsOn: string; eventId: string };
  showcase: null | { plans: TariffPlan[]; contact: AdminContact; email: string;
                     request: { planInterest: string | null; channel: string | null; lastContactAt: string | null } | null };
}
```

`mode`: `workspace` — є доступний простір або `canCreate`; `blocked` — є простори, але всі призупинені (з прив'язаним
тарифом, що минув/відкликаний); `showcase` — інакше. `showcase` заповнений і для `blocked` (контакт потрібен) — `plans`
можуть бути порожні. `banner` — лише власнику, для найближчого за строком простору, лише стани `expiring|grace` і не
`legacy`. `toast` — найновіша подія `granted/renewed` власника за 7 днів, яку ще не підтверджено (`ack_space_tariff_toast`).

### Інші

- `get_team_tariff(p_team uuid) → TeamTariff` (учасник простору; простір може бути призупиненим).
- `ack_space_tariff_toast(p_event uuid) → boolean`.
- `join_team_workspace_waitlist(p_plan text default null, p_channel text default null) → boolean` (`channel` ∈
  `telegram|email|copy|null`).
- `request_space_owner_nudge(p_team uuid) → jsonb { sent: boolean, nextAllowedAt: string | null }` (учасник
  призупиненого простору, не власник).
- `resume_team_catalog_updater(p_team uuid) → boolean`.
- `can_access_team_workspace() → boolean`, `list_my_teams()` — без змін сигнатури.

## Адмін (`is_admin()`, інакше `PERMISSION_DENIED`)

```ts
type AdminTariffRow = {
  id: string;
  ownerEmail: string;
  ownerId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  planCode: string;
  planNameUk: string;
  baseSeats: number;
  extraSeats: number;
  seatsTotal: number;
  seatsUsed: number;
  pendingInvites: number;
  startsAt: string;
  endsOn: string;
  daysLeft: number;
  graceUntil: string;
  revokedAt: string | null;
  state:
    | 'internal'
    | 'legacy'
    | 'active'
    | 'expiring'
    | 'grace'
    | 'blocked'
    | 'pending'
    | 'pending_expired';
  legacyAlso: boolean; // старе правило теж відкриває простір
  source: 'manual' | 'trial';
  externalRef: string | null;
  note: string | null;
  grantedBy: string | null;
  createdAt: string;
  updatedAt: string;
};
type AdminTariffEvent = {
  id: string;
  tariffId: string | null;
  actorId: string | null;
  actorName: string | null;
  kind:
    | 'granted'
    | 'updated'
    | 'extended'
    | 'ended_today'
    | 'ended_now'
    | 'undone'
    | 'member_removed'
    | 'invitation_revoked'
    | 'bound'
    | 'claimed'
    | 'owner_deleted'
    | 'settings';
  before: object | null;
  after: object | null;
  createdAt: string;
  undoable: boolean;
};
```

- `admin_list_space_tariffs() → AdminTariffRow[]` (чинні й відкликані за 30 днів).
- `admin_list_tariff_plans() → TariffPlan[]`.
- `admin_list_owner_spaces(p_email text) → Array<{teamId, name, membersUsed, boundTariffId: string|null}>`.
- `admin_preview_space_tariff(p_email text, p_team uuid) → { accountExists: boolean, ownerName: string|null,
seatsUsed: number, pendingInvites: number, suggestedExtraSeats: number /* для Ліда */, occupants: Array<{userId, name,
email, role, kind: 'member'|'invitation'}> }`.
- `admin_grant_space_tariff(p_email text, p_plan text, p_ends_on date, p_extra_seats int, p_team uuid default null,
p_note text default null, p_external_ref text default null, p_notify boolean default false, p_source text default
'manual') → AdminTariffRow`. Помилки: `TARIFF_DATE_INVALID`, `SEATS_IN_USE`, `TARIFF_BOUND` (простір уже має тариф),
  `INVALID_INPUT`.
- `admin_update_space_tariff(p_id uuid, p_plan text, p_ends_on date, p_extra_seats int, p_note text, p_external_ref
text) → AdminTariffRow`.
- `admin_extend_space_tariff(p_id uuid, p_months int, p_notify boolean default false) → AdminTariffRow & { eventId }`
  (від `ends_on`, якщо стан не `blocked`; інакше від київського сьогодні).
- `admin_end_space_tariff(p_id uuid, p_now boolean) → AdminTariffRow` (`p_now=false` → `ends_on = сьогодні`;
  `true` → `revoked_at = now()` і негайна пауза фону). Чекаючу видачу (`pending`) — скасовує.
- `admin_undo_space_tariff_event(p_event uuid) → AdminTariffRow` (лише останню подію тарифу видів
  `extended|updated|ended_today|ended_now`, не старшу за 10 хв).
- `admin_list_space_tariff_events(p_id uuid) → AdminTariffEvent[]`.
- `admin_list_tariff_seats(p_team uuid) → Array<{userId|null, invitationId|null, name, email, role, kind, isOwner,
isAdmin}>`.
- `admin_remove_tariff_member(p_team uuid, p_user uuid) → boolean` (власника — `INVALID_INPUT`).
- `admin_revoke_tariff_invitation(p_invitation uuid) → boolean`.
- `admin_list_legacy_spaces() → Array<{teamId, name, ownerEmail, ownerName, membersUsed}>` — відкриті лише старим правилом.
- `admin_list_space_requests() → Array<{userId, email, name, planInterest, channel, createdAt, lastContactAt,
handledAt, adminNote, hasTariff: boolean}>`.
- `admin_mark_space_request(p_user uuid, p_handled boolean, p_note text default null) → boolean`.
- `admin_get_tariff_settings() → { telegram: string|null, email: string|null, legacyRuleEnabled: boolean,
legacySpacesRemaining: number }`.
- `admin_set_tariff_settings(p_telegram text, p_email text, p_legacy_rule_enabled boolean, p_confirm boolean default
false) → той самий об'єкт` (`LEGACY_SPACES_REMAIN`, якщо вимикають з залишками без `p_confirm`).

## Сервіс (service_role)

- `service_claim_tariff_notices(p_limit int default 20) → Array<{ id, kind, tariffId, teamId, teamName, recipientEmail,
recipientName, locale: 'uk'|'en', planNameUk, planNameEn, endsOn, graceUntil, updaterRunning, contact: AdminContact,
memberName /* для member_nudge */ }>` — лізинг 5 хв; невідповідні строку → `superseded`.
- `service_finish_tariff_notice(p_id uuid, p_sent boolean, p_error text default null, p_skipped boolean default false)
→ boolean` (3 невдачі → `failed`).

## Edge `tariff-notices`

`POST` з `x-catalog-sync-secret`; тіло ігнорується. Відповідь `{ claimed, sent, skipped, failed }`. У `SOTY_ENVIRONMENT=beta`
— кожен лист `skipped`. Шаблони uk/en за `locale`; посилання — `WISHLY_SITE_URL/team`; контакт — `https://t.me/<login>`
і `mailto:`; усе екранується.
