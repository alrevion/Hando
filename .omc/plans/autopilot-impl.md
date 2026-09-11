# План — шаги 3–7

## Шаг 3 — напоминания
- `migrations/0021_schedule.sql`: orgs(work_days, work_start, work_end, lunch_start, lunch_end, always_on, digest_enabled, digest_time); users(notify_mode, remind_before_min); org_memberships(digest_sent_on); `reminders(assignee_id, kind, sent_at, PK)`.
- `src/schedule.ts` (новый лист): `OrgSchedule`, `loadSchedule(env, orgId)`, `inWorkHours(s, now)`, `dayEnd(s)` → 'HH:MM', `isWorkDay`, `localHm(now, tz)`, `digestDueNow(s, now)`.
- `src/quiet.ts`: `isQuiet` → обёртка над `!inWorkHours` (quiet_hours=0 → никогда тихо). `src/outbox.ts`: payload `gated?: boolean`; гейт = urgent ? нет : (gated || user.notify_mode==='schedule') && quiet_hours && !inWorkHours; замороженный получатель — строка гасится.
- `src/scheduled.ts`: `remindMatrix(env)` вместо escalateOverdue/remindApproachingDeadline; `sendDigests(env)`; cron `*/5 * * * *` (wrangler.toml). `nudge_remind` → удаляет reminders 'not_accepted' по задаче.
- `src/parse.ts`: `matchDeadline(text, now, tz, dayEnd='18:00')`, `parseTask(..., dayEnd)`, `refineDraft(..., dayEnd)`; bot/routes/drafts: час из графика (`dayEnd`) вместо DUE_HOUR/18.
- `src/bot.ts`: загрузчик задачи по id + membershipRole(task.org_id); экран «Настройки» (BTN.settings и кнопки-переключатели); `createOrg` ставит always_on для категории home.
- `src/routes.ts`: PATCH /me (+notify_mode, remind_before_min), PATCH /orgs/:orgId (+график/сводка, владелец), GET /me и /orgs/mine отдают поля.
- Тесты: `test/schedule.test.ts`.

## Шаг 4 — иерархия
- `migrations/0022_hierarchy.sql`: org_memberships(invited_by, invite_code, frozen_at) + индекс.
- `src/signup.ts`: `inviteCodeFor(env, orgId, userId)`, `joinByInvite(env, userId, code)` (invited_by=inviter, возвращает inviterTgId), `pendingRequests(env, orgId, viewerId)` (владелец — все, иначе invited_by=viewer), `pendingOrgFor` — владелец или пригласивший; approveJoin/rejectJoin — тот же гейт; отдел по умолчанию для admin — его первая доска.
- `src/hierarchy.ts` (новый): `subtreeOf`, `visibleUserIds(env, orgId, userId, role)`, `canAssign(env, orgId, actor, role, targetId)`, `returnOpenTasks(env, orgId, userId, actorId, label)` (уведомления авторам с Переназначить/Отменить, строки → declined), `freezeMember`, `unfreezeMember`.
- Применить: GET /users (все роли, фильтр), snapshot.users, reassignCandidates, dictate roster, PATCH /drafts assignee, POST /projects/:id/tasks; GET /org/subtree-tasks; POST /users/:id/freeze|unfreeze; DELETE /orgs/:orgId/members/:userId → returnOpenTasks; PATCH /users/:id role ∈ {admin, member} (creator any кроме creator/super_admin; admin — в поддереве).
- Роли в текстах: бот roleKeyboard (m/a), roleName; приложение ROLES/ROLE_NAME.
- Бот: `/start j_<code>`; карточка заявки с контактом (InlineButton.url); `GET /orgs/:orgId/invite`.
- Сессия без организации: mintSession(org_id null) + requireAuth пропускает белый список (GET /me, GET /orgs/mine, GET /packs, POST /orgs, POST /orgs/join, PATCH /me); фронт: NoOrgScreen.
- Тесты: `test/hierarchy.test.ts`; правки step2a FIXTURES (новые роуты), signup.test (approver rules).

## Шаг 5 — экраны
- MobileShell: вкладки Поручения/Задачи/Календарь/Ещё; MoreView с подэкранами (Profile → ProfileSheet как экран, PeopleView+карточка/аналитика, OrgView, DraftsView, AllTasksView, NotifyView, AskView).
- MyTasksView: секции по этапам + кнопки (Взять · Готово · Не успею · Отказать); AssignedView: секции + Принять/Вернуть/Переназначить/Удалить.
- TaskDetailModal: правка темы, удаление, вложения (GET/POST attachments).
- `lib/toast.ts` + `<Toaster/>`; календарь css; api.ts новые функции; `GET /users/:id/stats`, `POST /tasks/:id/late`.
- Тесты: серверные роуты в реестрах; фронт — tsc + превью.

## Шаг 6 — помощник
- `src/assistant.ts`: `askAssistant(env, {userId, orgId, role, name}, question, history)`; MANUAL текст; задачи человека в контекст. Бот: BTN.ask, await 'ask', history в bot_state (≤6). Роут POST /ask. Фронт AskView. Тест с подменой fetch.

## Шаг 7 — обучение
- Бот: /start и /help — тезисы + web_app кнопка «Открыть приложение». Фронт: TipsCard (localStorage).

## Порядок и проверка
3 → 4 → 5 → 6 → 7; после каждого шага: tsc, vitest, коммит. В конце: deploy (миграции remote), превью-прогон приложения, локальный вебхук-прогон бота, документ (дорожная карта), архитектор+безопасность+качество.
