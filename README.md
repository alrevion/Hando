# Hando

A Telegram assistant for tasks in small teams and families: say or type a request, and Hando turns it into tasks,
deadlines and reminders. Live at [hando.alrevion.com](https://hando.alrevion.com).

> "remind me tomorrow to call the bank" → a task for me
> "Artur, send the report by Friday" → a task for Artur; he taps **Accept**

**The key decision:** a task for yourself is just a task whose assignee is its author. One `tasks` table, one reminder
loop, one speech parser, one `events` log — the personal and the team modes differ only in confirmation steps.

## What it does

- **Voice and text in, structured actions out.** An LLM (`gpt-oss-120b`) parses each message into actions — create, edit,
  accept, decline, done, late, return, delete — with dates, people and priority; it asks back only when it cannot tell which task or person is meant.
- **Assignment with acknowledgement.** A teammate's task goes `SENT → ACCEPTED → DONE`; overdue and unaccepted tasks are
  nudged and escalated; quiet hours are respected.
- **Teams.** Roles and hierarchy, projects with their own Telegram groups, checklists, drafts, attachments stored in Telegram.
- **Industry packs.** Preset roles and wording per industry (e.g. a school pack with an academic office and class teachers).
- **Web app and MCP.** A React board for the same data, and an MCP server so AI agents can read and create tasks.
- **Semantic search** through a small self-hosted embedding service (`deploy/embed`).

## Stack

Cloudflare Workers + Hono, D1 (SQLite), cron every minute, React + Vite (`frontend/`), Telegram Bot API.

## Run and test

```bash
npm install
npm test                 # unit and integration tests (vitest, Workers runtime)
npm run eval:brain       # language-understanding eval against the real model
npm run dev
```

Secrets go to `.dev.vars` locally and `wrangler secret put` in production.

Hando grew out of [Sayn](https://github.com/alrevion/Sayn), our earlier kanban board.

---

© 2026 Alrevion. Source published for review; all rights reserved.
