# План — Шаг 2: карточка адресата

## Файлы
1. `src/telegram.ts` — `InlineButton = { text; callback_data?: string; web_app?: { url } }`; `InlineKeyboard.inline_keyboard: InlineButton[][]`.
2. `src/transition.ts` — `composeText`: человеческий текст (title в «», «От кого/Кто», срок словами через `formatWhen` в поясе организации, важность), без URL-строки; `buildNotification`: keyboard = `[...buttons, [openButton(task.id)]]`; `notify.buttons` типа `InlineButton[][]`. Экспорт `openButton(taskId)`.
3. `src/intake.ts` — карточка при создании из бота: `assigneeButtons(task)` (accept/late/decline или ack).
4. `src/routes.ts` — карточка при создании из приложения (POST /projects/:id/tasks) теми же кнопками; `/tasks/:id/decline` — вынести общую `declineAssignee(env, task, mine, actorId, reason)` в `assignees.ts`, чтобы бот и API шли одним путём.
5. `src/menu.ts` — `BotState.await` += `'late' | 'decline'`; `task?: string`.
6. `src/bot.ts` — callbacks `accept`, `ack`, `late`, `decline`, `keep`, `ra`, `cancel`; удалить `done`; текстовая ветка для await late/decline; после accept клавиатура → только «Открыть».
7. `src/nudges.ts`, `src/outbox.ts` — тип кнопок → `InlineButton`.
8. Тесты: `test/card.test.ts` (сценарии из спецификации), правка `test/step4.test.ts` (`done:bot` больше не двигает строку → сценарий «закрытие только из приложения»), `test/parse.test.ts` не трогается.
9. Документ: строка шага 2 в дорожной карте → сделано; долг «Не успею в приложении».

## Порядок
telegram → transition → intake/routes → menu → bot → tests → tsc/vitest → deploy.

## Риски
- `editMessageReplyMarkup` после accept должен оставить «Открыть», а не гасить всё.
- Rollup для ack: `accepted` закрывает задачу (assignees.ts:135) — проверить тестом.
- Reassign гасит ВСЕ живые строки — приемлемо для single/any, не показывать для each.
