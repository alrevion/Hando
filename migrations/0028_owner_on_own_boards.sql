-- Владелец не числился участником отделов, созданных из профиля.
--
-- Видимость людей считается по участию в досках, и человек, добавленный в
-- «Дети», не находил в списке того, кто его туда и добавил: у владельца строки
-- на этой доске не было, хотя он её и завёл. Ручное создание доски строку
-- ставило -- расходились только отделы, которые заводятся вместе с
-- организацией по выбранному профилю.
INSERT OR IGNORE INTO project_memberships (id, project_id, user_id, org_id)
SELECT lower(hex(randomblob(16))), p.id, p.created_by, p.org_id
FROM projects p
WHERE p.created_by IS NOT NULL
  AND p.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_memberships m
    WHERE m.project_id = p.id AND m.user_id = p.created_by
  );
