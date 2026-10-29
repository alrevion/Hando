-- Hando закрыт целиком, а не только нейросети: пользоваться ботом и
-- приложением могут только люди с allowed = 1 -- те, кто был до 0037.
-- Новые не заводятся и не обслуживаются. Пустить человека:
-- UPDATE users SET allowed = 1 WHERE id = ?.
ALTER TABLE users RENAME COLUMN ai_enabled TO allowed;
