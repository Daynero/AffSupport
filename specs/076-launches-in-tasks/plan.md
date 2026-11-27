# План 076 · Запуски в завданнях

[Вимоги](spec.md) · [Задачі](tasks.md)

## База даних — міграція `20261225100000_task_launch_links.sql`

```sql
create table public.team_task_launches (
  team_id uuid not null references public.teams(id) on delete cascade,
  task_id uuid not null,
  launch_id uuid not null,
  attached_by uuid references auth.users(id) on delete set null,
  attached_at timestamptz not null default now(),
  primary key (task_id, launch_id),
  foreign key (task_id, team_id) references public.team_tasks(id, team_id) on delete cascade,
  foreign key (launch_id, team_id) references public.team_launches(id, team_id) on delete cascade
);
create index team_task_launches_launch_idx on public.team_task_launches (team_id, launch_id);
-- RLS on, force; читання — учасникам простору; запис — лише через RPC (security definer).
-- Ім'я team_* → тригер task_cleanup_reference_fence (правило інвентаря прибирання).
```

RPC (усі `security definer`, `search_path = ''`, помилки — наявні коди `PERMISSION_DENIED` / `INVALID_INPUT` / `NOT_FOUND`):

| Функція                                                                                                 | Що робить                                                                                                |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `attach_team_task_launches(p_team, p_task, p_launches uuid[])` → `jsonb {attached, alreadyAttached}`    | `private.can(p_team,'edit')`; 1–100 id; запуски цього простору й не архівовані; `on conflict do nothing` |
| `create_team_task_with_launches(p_team, p_title, p_launches uuid[])` → task row (як `create_team_task`) | створює завдання через `create_team_task` і прив'язує в одній транзакції                                 |
| `detach_team_task_launch(p_team, p_task, p_launch)` → void                                              | edit                                                                                                     |
| `list_team_task_launch_ids(p_team, p_task)` → `uuid[]`                                                  | view; лише неархівовані, за `attached_at`                                                                |
| `list_team_launch_tasks(p_team, p_launches uuid[])` → `jsonb [{launchId, taskId, title, status}]`       | view; для чипів на картках (≤100)                                                                        |

Права: «view» для читання як у завдань (`private.can(p_team,'view')`), запуски читаються через наявний `list_launches` з фільтром `ids`.

## Веб

| Файл                               | Зміна                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `api/team.ts`                      | `attachTaskLaunches`, `createTaskWithLaunches`, `detachTaskLaunch`, `listTaskLaunchIds`, `listLaunchTasks`          |
| `team/tasks/TaskLaunches.tsx`      | новий блок «Запуски» в редакторі: `launchesApi.list(teamId, {ids})`, компактні `LaunchCard`, «Прибрати», «+ Додати» |
| `team/tasks/TaskLaunchPicker.tsx`  | вибір запусків (075 `PickerDialog` multiple) — `launchesApi.list` з пошуком                                         |
| `team/tasks/TaskEditor.tsx`        | блок під тегами акаунтів; пункт «Повторити завдання» в меню                                                         |
| `team/launches/LaunchesToTask.tsx` | вибір завдання (075 single) + «+ Нове завдання» → attach / create-with                                              |
| `team/launches/LaunchSpace.tsx`    | «У завдання…» на смузі масових дій                                                                                  |
| `team/launches/LaunchCard.tsx`     | чип завдання; пункт меню «У завдання…»                                                                              |
| `locales/{uk,en}.ts`               | тексти                                                                                                              |

## Тести

- `supabase/tests/task_launch_links.test.sql` (pgTAP, як сусідні): права, дублікати, чужий простір, архівований запуск, каскади, тригер огорожі, `task_cleanup_coverage_verified()` = true.
- `tests/task-launches.test.tsx`: масова дія → вибір → attach; створення нового; блок у завданні; прибрати; чип на картці.

## Викладка на бету

Міграцію на бету — через psql + запис у `schema_migrations` (пам'ять: `migration up` на беті заблоковано чужою версією), ніколи `db reset`. Після — `select private.task_cleanup_coverage_verified()`.
