# Deep Interview Spec: Internal Kanban Board (Cloudflare + D1)

## Metadata
- Interview ID: kanban-di-2026-07-19
- Rounds: 7 (+ Round 0 topology gate)
- Final Ambiguity Score: ~12.5%
- Type: greenfield
- Generated: 2026-07-19
- Threshold: 0.2 (20%)
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 40% | 0.368 |
| Constraint Clarity | 0.90 | 30% | 0.270 |
| Success Criteria | 0.79 | 30% | 0.237 |
| **Total Clarity** | | | **0.875** |
| **Ambiguity** | | | **0.125** |

## Topology

| Component | Status | Description | Coverage |
|-----------|--------|-------------|----------|
| Auth (phone-number login) | active | Login by phone/OTP, mirroring Ijoda | Reuses existing `auth-api` service, invite-only |
| Roles & Access Control | active | creator > super-admin > admin | Full permission matrix + audit trail resolved |
| Projects (sidebar) | active | Add/remove projects in sidebar | CRUD ownership + delete semantics resolved |
| Kanban Board | active | Core task board | Card fields, columns, full lifecycle state machine resolved |
| Deadlines & Telegram Notifications | active | Deadline tracking + bot escalation | Added round 6-7; cadence and message lifecycle fully specified |

No components were deferred.

## Goal

Build a lightweight, custom internal Kanban board for the company's projects, deployed on Cloudflare (Workers/Pages + D1), reusing the existing `auth-api` phone/OTP login service (same pattern as Ijoda). Users are provisioned only by `creator`/`super-admin` (no self-signup). A sidebar lists projects a user has access to; `super-admin`/`creator` manage projects and staff; `admin` users work tasks within the projects they've been assigned to. Tasks move through a fixed Todo -> In Progress -> Done -> Archive lifecycle, with deadlines enforced via a Telegram bot that escalates overdue tasks every 5 minutes until resolved.

## Constraints

- Deploy target: Cloudflare Workers/Pages + D1 (SQLite). No Postgres/MongoDB, no long-running server process.
- Auth is a client of the existing shared `auth-api` Cloudflare Worker (`api.auth.alrevion.com`), OTP delivered via Telegram — not reimplemented from scratch.
- No self-registration. Accounts must be pre-created by `creator`/`super-admin` before a phone number can log in.
- Role hierarchy (3 tiers): `creator` (root, superset of all `super-admin` powers, exclusively creates `super-admin` accounts) > `super-admin` (creates/deletes projects, creates `admin` accounts, assigns admins to projects, sees all projects globally) > `admin` (sees/works only in projects they've been explicitly assigned to).
- Access control is enforced at the API level, not just hidden in the UI: an `admin` cannot fetch another project's data even via direct API/URL manipulation.
- Within an assigned project, any `admin` can edit/move a task, but **only `super-admin`/`creator` can delete a task** (which archives it, never a hard delete).
- Card fields: title, description, responsible/assignee, optional deadline (date).
- Columns are fixed and identical across all projects: Todo, In Progress, Done. No custom/per-project columns.
- **Edit lock:** a card is editable only while in Todo. Once moved to In Progress, it can no longer be edited nor sent to archive (until it returns to Todo, e.g. via rejection — see Acceptance Criteria).
- **Archive is not a hard delete:** archived cards can be restored, but restoring requires a mandatory comment. Auto-archive triggers automatically after a card sits in Done for 7 days without action.
- `creator`/`super-admin` have a per-project Archive tab showing all archived tasks and who did what. `admin` has a personal Archive tab scoped to only the tasks *they* completed (for their own accountability).
- Moving a card to Done is not final completion — `super-admin`/`creator` must explicitly confirm. If they reject it as not actually done, it returns to In Progress and the original deadline/reminder timer keeps running (not reset).
- Two independent notification mechanisms coexist: (1) ~5s client-side polling so open board tabs refresh without a manual reload, and (2) a Telegram bot posting to a group chat — announces responsible person + deadline when a task starts, escalates with an "ВЫ ПРОСРОЧИЛИ ДЕДЛАЙН" tag every 5 minutes after the deadline passes until moved to Done, then deletes its own escalation messages.

## Non-Goals

- No custom/configurable columns per project (fixed 3-column model only).
- No self-service signup or OAuth/email/password login — phone/OTP via the existing auth-api only.
- No real-time push infra (WebSockets/Durable Objects) — polling + Telegram bot cover the freshness/notification need at this scale.
- No adoption of an existing OSS kanban codebase (Planka/Wekan/Vikunja/Focalboard/Kanboard/Taiga/Kan) as the running system — confirmed as impractical given the Cloudflare+D1 + custom-auth/role requirements (see Technical Context).
- No multi-tenant/SaaS concerns — single company, internal use only.

## Acceptance Criteria

- [ ] A user with a phone number pre-created by `creator`/`super-admin` can log in via OTP (through the existing auth-api / Telegram flow); an unregistered phone number cannot.
- [ ] `creator` can create `super-admin` accounts; no other role can.
- [ ] `super-admin` can create/delete projects, create `admin` accounts, and assign admins to specific projects; `super-admin` sees all projects.
- [ ] An `admin` only sees, in the sidebar, projects they've been assigned to — confirmed both in the UI and by direct API calls to other projects returning a permission error.
- [ ] Within an assigned project, an `admin` can create/edit/move a task while it's in Todo, and move it Todo -> In Progress -> Done, but cannot delete/archive it and cannot edit it once it has left Todo.
- [ ] Only `super-admin`/`creator` can delete a task; deletion moves it to Archive (never a hard delete) and is visible in the project's Archive tab with who did it.
- [ ] A task sitting in Done for 7 days with no action is automatically archived.
- [ ] An archived task can be restored, but only if a comment is provided at restore time.
- [ ] `admin` can open a personal Archive tab (scoped to any project they belong to) and see only the tasks they themselves completed.
- [ ] Moving a task to Done does not mark it complete; `super-admin`/`creator` must confirm completion, and if the task was completed after its deadline, the overdue duration is shown.
- [ ] If `super-admin`/`creator` rejects a Done task as not actually finished, it returns to In Progress and its original deadline/reminder schedule continues (not reset).
- [ ] When a task moves to In Progress, the Telegram bot posts to the configured group chat naming the responsible person and the deadline.
- [ ] Once a task's deadline passes without being moved to Done, the bot sends a tagged "ВЫ ПРОСРОЧИЛИ ДЕДЛАЙН" reminder to the group every 5 minutes; once the task reaches Done, all such escalation messages are deleted from the group.
- [ ] An open board view reflects other users' changes within ~5 seconds without a manual page reload (polling).
- [ ] All admin/super-admin destructive/administrative actions (project delete, task delete/archive/restore) are attributable to a specific user and timestamp, visible to `creator` via the Archive/audit views.

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| Existing OSS kanban tools could be adopted directly | Researched Planka/Wekan/Vikunja/Focalboard/Kanboard/Taiga/Kan against Cloudflare D1 + custom auth/role fit | None fit without a near-total rewrite; build custom, use OSS only as UI/UX reference |
| "Login by phone" implies new OTP logic to build | Explored Ijoda's actual implementation | Ijoda proxies to an already-deployed shared `auth-api` Worker (OTP via Telegram) — Kanban should reuse that same service, not reinvent it |
| Per-project visibility restriction is a hard security requirement | Contrarian: what if any admin could technically reach any project, just hidden in the sidebar? | User confirmed strict API-level enforcement is required, not just a UI filter — plus added an audit-log requirement for accountability |
| Board needs real-time push (WebSockets/Durable Objects) | Simplifier: is polling/manual refresh enough for a small internal team? | Resolved to lightweight ~5s client polling (no Durable Objects) *plus* a separate Telegram bot for async group notifications — the two serve different audiences and both are needed |
| Moving a card to "Done" means the task is finished | Follow-up on delete/archive semantics surfaced a hidden requirement | Done is provisional; `super-admin`/`creator` must confirm completion, with overdue duration shown, and can reject back to In Progress with the deadline timer continuing |

## Technical Context

Greenfield build. Key reference points gathered before interviewing:

- **Auth reuse target:** `api.auth.alrevion.com` (auth-api Cloudflare Worker), the same service Ijoda's `cabinet/supabase/functions/auth-login/index.ts` proxies to for OTP-via-Telegram login. Kanban should integrate as a client of this service rather than reimplementing OTP.
- **Ijoda RBAC precedent:** `db/schema.sql`'s `user_role` enum (`creator, super_admin, admin, manager, photographer, client`) is a partial precedent for the role hierarchy, but is flat/single-tenant with no per-project scoping — the per-project visibility/access-control layer is new work, not something to copy from Ijoda.
- **OSS kanban survey:** none of Planka, Wekan, Vikunja, Focalboard, Kanboard, Taiga, or Kan run natively on Cloudflare D1/Workers (all assume Postgres/MongoDB + a persistent server process), and none combine phone-OTP login with a creator/super-admin/admin per-project role model without a substantial fork. Recommendation followed: custom-built on Workers + Pages + D1.
- **Deployment shape:** expected to follow the same pattern as Ijoda/other Alrevion services — Cloudflare Worker(s) with static asset bindings for the frontend, D1 for data. Exact subdomain/wrangler config not yet decided (low-priority, decide at implementation/deploy time).
- **Telegram bot config:** the user will add a bot to an existing Telegram group; bot token/chat ID wiring is an implementation-time detail, not a requirements gap.

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| User | core domain | phone, role (creator\|super_admin\|admin) | User has many ProjectMemberships (as admin); User is referenced as Task.responsible |
| Project | core domain | name | Project has many Tasks; Project has many admins via ProjectMembership |
| ProjectMembership | supporting | project_id, admin_id | Links an `admin` User to a Project they can access |
| Task | core domain | title, description, responsible/assignee, column (todo\|in_progress\|done), deadline (optional date), locked (derived: true once not in todo) | Task belongs to Project; Task assigned to User (responsible) |
| Column | supporting | fixed set: Todo / In Progress / Done | Column contains Tasks |
| ArchiveEntry | supporting | task snapshot, archivedBy (user or "system" for auto-archive), archivedAt, restoredComment (nullable), confirmedBy (super_admin\|creator), overdueBy (duration, nullable) | References the archived Task and the acting User |
| TelegramNotification | external system | group_chat_id, message_id (for cleanup), escalation_interval (5 min) | References Task and its responsible User |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 4 | 4 | - | - | N/A |
| 4 | 5 | 1 (AuditLog) | 0 | 4 | 80% |
| 7 | 8 | 2 (ProjectMembership, TelegramNotification) | 1 (AuditLog -> ArchiveEntry) | 4 | 83% |

The core four entities (User, Project, Task, Column) were stable from round 1 onward. AuditLog (round 4) converged into the more concrete ArchiveEntry (round 7) once the archive/confirmation workflow was fully specified — a rename reflecting the same underlying need (attributable history of actions on tasks), not scope churn.

## Interview Transcript

<details>
<summary>Full Q&A (7 rounds + Round 0 topology gate)</summary>

### Round 0 — Topology confirmation
**Q:** Confirmed reading of 4 top-level components: Auth, Roles & Access Control, Projects, Kanban Board.
**A:** Structure correct, proceed.

### Round 1 — Kanban Board / Goal Clarity
**Q:** What complexity does the board need — card fields, fixed vs configurable columns?
**A:** Minimal: title + description + assignee; fixed columns (Todo/In Progress/Done), same across all projects.

### Round 2 — Roles & Access Control / Constraint Clarity
**Q:** Who creates/deletes projects, and does `creator` use the board itself or is it a pure root account?
**A:** `creator` is a superset role — everything `super-admin` can do, plus exclusively creates `super-admin` accounts.

### Round 3 — Auth / Goal Clarity
**Q:** Should Kanban reuse the existing `auth-api` service (as Ijoda does), or build a separate/standalone mechanism? Self-registration or invite-only?
**A:** Reuse the same auth-api. Invite-only, no self-registration.

### Round 4 — Roles & Access Control / Constraint Clarity (Contrarian Mode)
**Q:** Would it be acceptable for an `admin` to technically be able to reach any project (just hidden in the sidebar), or must access be blocked even at the API level? Can any `admin` in a project edit/move any card, or only the assignee?
**A:** Strict API-level enforcement required. Any admin in the project can edit/move any card. New requirement: log all admin/super-admin actions so `creator` can see who did what (e.g., who deleted a card).

### Round 5 — Projects / Success Criteria
**Q:** When a project/card is deleted, is it permanent, or reversible?
**A:** Reframed entirely: only `super-admin`/`creator` can delete cards, which go to Archive (not deleted); cannot be deleted from Archive; `creator`/`super-admin` have a per-project Archive tab; `admin` can only move cards; cards auto-archive after 7 days in Done.

### Round 6 — Kanban Board / Success Criteria (Simplifier Mode)
**Q:** Does the board need real-time updates (WebSockets/Durable Objects) or is manual refresh sufficient? Are email/Telegram notifications needed on task assignment?
**A:** Major expansion: `admin` also gets a personal Archive tab (scoped to tasks they completed); archived cards can be restored with a mandatory comment; cards are editable only in Todo, locked once In Progress; added deadline and responsible-person fields; no traditional notifications, but ~5s client polling for freshness, plus a full Telegram bot: posts on task start (responsible + deadline), escalates every 5 min after deadline miss tagging the person ("ВЫ ПРОСРОЧИЛИ ДЕДЛАЙН"), deletes escalation messages on completion; Done requires `super-admin`/`creator` confirmation showing overdue duration if late.

### Round 7 — Kanban Board + Deadlines & Notifications / Success Criteria
**Q:** If a confirmer rejects a "Done" card as not actually finished, what happens to it and its deadline timer? Should both 5s polling and the Telegram bot coexist, or does the bot replace polling?
**A:** Rejected cards return to In Progress with the original deadline/reminder timer continuing (not reset). Both mechanisms coexist — they serve different audiences (browser viewers vs. the Telegram group).

</details>
