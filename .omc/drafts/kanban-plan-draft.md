# Work Plan: Internal Kanban Board (Cloudflare Workers + D1)

Source spec: `.omc/specs/deep-interview-kanban.md` (ambiguity 12.5%, PASSED)

## RALPLAN-DR Summary (short mode)

**Principles**
1. Reuse existing infra (`auth-api`) rather than reinventing phone/OTP auth.
2. Enforce access control at the API layer, not just the UI — this was an explicit hard requirement (Round 4), not a nice-to-have.
3. Prefer the simplest mechanism that satisfies each requirement — 5s polling over WebSockets/Durable Objects, a single Worker over a multi-service split, matching the user's own "small internal tool" framing and the Round 6 Simplifier decision.
4. Never hard-delete data — archive/soft-delete everywhere (tasks and, by extension, projects), consistent with the archive-first model the user specified for tasks.
5. Stay single-tenant/internal — no multi-tenant scaffolding, no SaaS-grade elasticity; this is one company's internal tool.

**Decision Drivers (top 3)**
1. Hard infra constraint: must run entirely on Cloudflare Workers + D1 (no Postgres/Mongo, no persistent server process).
2. Must reuse the existing `auth-api` service (api.auth.alrevion.com) for phone/OTP login rather than duplicating that logic, per the interview decision.
3. Must faithfully implement the specific card lifecycle + Telegram escalation workflow from the spec — this workflow *is* the product's value proposition (deadline accountability), not an add-on.

**Viable Options**

### Option A: Single Worker, D1, Cron Triggers (Recommended)
One Cloudflare Worker (Hono router) serves both the API and the static frontend assets (assets binding, same pattern Ijoda already uses for `app`/`cabinet`). D1 holds all data. Cloudflare Cron Triggers run the auto-archive sweep and the 5-minute deadline-escalation check inside the same Worker.
- **Pros:** Simplest possible deploy (one `wrangler.jsonc`, one D1 binding), matches the existing Alrevion Workers-as-static-host pattern, least moving parts for a small internal tool with low data volume.
- **Cons:** All logic lives in one Worker, which could get large if the tool grows significantly — acceptable at the described scale.

### Option B: Split Workers (frontend / API+cron), mirroring Ijoda's app/cabinet/photos-worker split
- **Pros:** Cleaner separation of concerns; matches the multi-worker pattern already used elsewhere in Alrevion.
- **Cons:** Doubles deploy/config surface (two `wrangler.jsonc`, CORS between them) for a project explicitly scoped as small and internal, with no stated need for independent scaling or team ownership boundaries.

**Invalidation rationale for Option B:** The spec's own Non-Goals explicitly rule out multi-tenant/SaaS concerns and any real-time infra beyond simple polling — Option B's main benefit (independent scaling/deploy boundaries) solves a problem this project doesn't have. Option A is adopted; Option B is the natural next step only if the tool later grows into a company-wide multi-product platform.

## Requirements Summary

Build a phone/OTP-gated internal Kanban tool with a 3-tier role hierarchy (creator > super-admin > admin), per-project visibility/access control enforced at the API level, a fixed 3-column board with an edit-lock + archive/confirm/restore lifecycle, and a Telegram bot that escalates overdue tasks every 5 minutes until resolved. Full detail in the source spec's Goal/Constraints/Acceptance Criteria sections.

## Data Model (D1 / SQLite)

- **users**: id, phone (unique), name, role (`creator`|`super_admin`|`admin`), created_at
- **projects**: id, name, created_by, created_at, archived_at (nullable — soft-delete; see Assumption below)
- **project_memberships**: id, project_id, user_id, created_at — defines which `admin`s can see a project
- **tasks**: id, project_id, title, description, responsible_user_id, status (`todo`|`in_progress`|`done`|`archived`), deadline (nullable date), done_at (nullable — timestamp entering `done`, drives 7-day auto-archive and overdue calc), archived_by (nullable user_id, null = system/auto), archived_at (nullable), restored_comment (nullable), confirmed_by (nullable user_id), confirmed_at (nullable), overdue_by (nullable seconds), telegram_message_ids (nullable JSON array, for escalation cleanup), created_at, updated_at
- **audit_log**: id, actor_id, action, target_type, target_id, metadata (json), created_at — covers non-task admin actions (project create/delete, membership changes) per the Round 4 audit requirement; task-level history is already captured directly on `tasks`.

**Assumption (flag for Architect/Critic):** the spec fully specifies task-level archive/restore semantics but only says "super-admin/creator delete projects" without detailing project-delete semantics. This plan assumes project deletion is also soft (sets `archived_at`, hides from sidebar, but its tasks remain visible via the project-scoped Archive view) rather than a hard delete, for consistency with the "never hard-delete" principle. Flagging explicitly rather than silently assuming.

## Implementation Steps

1. **Scaffold** (`workers/kanban/`): Cloudflare Worker project, Hono router, `wrangler.jsonc` with D1 binding + assets binding, D1 migrations for the schema above.
2. **Auth integration** (`workers/kanban/src/auth.ts`): client for `api.auth.alrevion.com` login/verify calls; on successful OTP verify, look up the phone in `users` (must pre-exist — no self-registration) and issue a Kanban-scoped session (signed cookie or JWT) carrying `user_id` + `role`.
3. **Access-control middleware** (`workers/kanban/src/middleware/access.ts`): single shared helper `requireProjectAccess(userId, projectId)` used by every project-scoped route — `super_admin`/`creator` always pass; `admin` passes only if a `project_memberships` row exists. This is the one place cross-project access is enforced, so it can be unit-tested in isolation.
4. **User/Project/Membership CRUD** (`workers/kanban/src/routes/{users,projects,memberships}.ts`): provisioning endpoints restricted by role (creator creates super_admin; super_admin creates admin + projects + memberships).
5. **Task CRUD + lifecycle** (`workers/kanban/src/routes/tasks.ts`): create/edit only while `status = todo`; column-move endpoint enforcing the edit-lock (no edit once `in_progress`); delete restricted to `super_admin`/`creator` (sets `status = archived`, `archived_by`, `archived_at`); restore endpoint requires `restored_comment`.
6. **Confirmation workflow**: `POST /tasks/:id/confirm` (super_admin/creator only) — sets `confirmed_by`, `confirmed_at`, computes `overdue_by` if `deadline` was passed; `POST /tasks/:id/reject` — returns task to `in_progress`, deadline/reminder state untouched (continues from original deadline).
7. **Scheduled jobs** (`workers/kanban/src/scheduled.ts`, Cron Trigger): (a) auto-archive sweep — any task with `status = done` and `done_at` older than 7 days moves to `status = archived`, `archived_by = null`; (b) deadline-escalation sweep (every 5 min) — for tasks in `in_progress` past `deadline`, post/append a Telegram escalation message tagging the responsible user; on task reaching `done`, delete all stored `telegram_message_ids`.
8. **Telegram bot integration** (`workers/kanban/src/telegram.ts`): thin wrapper over `api.telegram.org` `sendMessage`/`deleteMessage` using a Worker secret bot token + a configured group `chat_id`; called from the task-status-change handler (post on entering `in_progress`) and from the scheduled escalation sweep.
9. **Frontend** (`workers/kanban/frontend/`, React + Vite + TS + Tailwind, matching Ijoda's stack): login screen (phone + OTP), sidebar (assigned/all projects depending on role), board view (3 fixed columns, move actions respecting edit-lock), project-scoped Archive tab (super_admin/creator) and personal Archive tab (admin, filtered to own completed tasks), 5s polling on the board view.
10. **Deploy**: `wrangler deploy` from `workers/kanban/`, following the existing Alrevion pattern (subdomain + D1 + secrets for `AUTH_API_KEY` and `TELEGRAM_BOT_TOKEN`).

## Acceptance Criteria

Inherited verbatim from the source spec's Acceptance Criteria section (14 testable criteria covering auth, roles, board lifecycle, archive/restore, confirmation/rejection, and Telegram escalation) — see `.omc/specs/deep-interview-kanban.md#acceptance-criteria`.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Telegram only allows message deletion within ~48h of sending | Attempt deletion of every stored `telegram_message_ids` entry on completion; ignore individual failures for messages past the window (log, don't block completion) |
| Auto-archive/escalation cron granularity vs. exact 7-day/5-min timing | Run the escalation cron every 5 minutes (matches the spec exactly); auto-archive check can piggyback on the same cron tick, checked via `done_at` comparison, so no separate schedule is needed |
| Cross-project data leakage via API (the explicit hard requirement from Round 4) | Single shared `requireProjectAccess` middleware applied to every project-scoped route; dedicated test suite asserting a non-member admin gets 403 on every task/project endpoint |
| Dependency on external `auth-api` availability | Accepted — matches Ijoda's existing pattern; no additional mitigation scoped for MVP |
| D1 free-tier read/write limits | Low risk given explicitly small internal data volume; revisit if usage grows |

## Verification Steps

1. Unit tests for `requireProjectAccess` (member/non-member/role-elevated cases).
2. Integration test walking the full task lifecycle: create (todo) -> edit -> move to in_progress (edit now blocked) -> move to done -> confirm (on-time, no overdue) and a second run -> reject (returns to in_progress, deadline unchanged) -> eventually confirm late (overdue_by > 0).
3. Integration test: archive via delete (super_admin only; admin delete attempt returns 403) -> restore requires a comment (missing comment returns 400).
4. Manual QA against a real Telegram test group: bot posts on `in_progress` entry, escalates every 5 min past deadline tagging the user, deletes all escalation messages on completion.
5. Manual QA: auto-archive after 7 days in `done` (simulate by backdating `done_at` in D1 for the test row).
6. Manual QA: board view reflects another admin's change within ~5s without a manual reload.
