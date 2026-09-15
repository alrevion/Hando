-- Задача СЕБЕ рождается принятой (assignees.ts: initialState). Это чинит
-- новые задачи, но не те, что созданы раньше: их строки по-прежнему «не
-- принято», и они слали бы напоминание раз в час, пока человек не нажмёт
-- «Принять» у собственной задачи -- ровно то, на что жаловался владелец.
--
-- Своя строка -- та, где исполнитель и есть автор задачи. Рассылки «ознакомиться»
-- (ack) не трогаем: там принятие и есть закрытие, и переводить их молча значило
-- бы закрыть задачу за человека.
UPDATE task_assignees
SET state = 'accepted',
    accepted_at = COALESCE(accepted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE state = 'pending'
  AND user_id = (SELECT author_id FROM tasks WHERE tasks.id = task_assignees.task_id)
  AND (SELECT COALESCE(kind, 'single') FROM tasks WHERE tasks.id = task_assignees.task_id) <> 'ack'
  -- Только живые задачи: у закрытой и архивной строку трогать незачем.
  AND (SELECT status FROM tasks WHERE tasks.id = task_assignees.task_id) NOT IN ('done', 'archived');

-- Статус задачи -- свёртка строк: как только кто-то принял, задача «в работе».
UPDATE tasks
SET status = 'in_progress'
WHERE status = 'todo'
  AND COALESCE(kind, 'single') <> 'ack'
  AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = tasks.id AND a.state = 'accepted');
