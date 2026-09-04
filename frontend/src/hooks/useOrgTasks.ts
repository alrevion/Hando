import { useCallback, useEffect, useState } from 'react';
import type { Project, Task, User } from '../types';
import { ApiError, getProjects, getTasks, getUsers } from '../lib/api';
import { usePolling } from './usePolling';

// Задача вместе с названием своей доски. Сквозные экраны (Мои задачи, Люди,
// Календарь) показывают задачи вне контекста доски, и без названия проекта
// строка «Позвонить в банк» не говорит, откуда она взялась.
export interface OrgTask {
  task: Task;
  projectName: string;
}

/**
 * Все активные задачи организации, доступные текущему человеку.
 *
 * Сквозного эндпоинта «задачи организации» в API нет -- задачи отдаются только
 * по доскам (GET /projects/:id/tasks), поэтому список собирается здесь: один
 * запрос на доску поверх GET /projects. Досок у человека единицы, так что цена
 * приемлема; когда их станут десятки, это первое место, которое надо заменить
 * серверной выборкой, а не наращивать параллелизм здесь.
 *
 * Ошибка одной доски НЕ глотается: молча исчезнувшая доска в планировщике
 * опаснее видимой ошибки -- человек решит, что задач нет.
 */
export function useOrgTasks() {
  const [tasks, setTasks] = useState<OrgTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    getProjects()
      .then(async (list) => {
        setProjects(list);
        const perProject = await Promise.all(
          list.map((project) =>
            getTasks(project.id).then((rows) => rows.map((task) => ({ task, projectName: project.name }))),
          ),
        );
        // Архивные сюда не попадают: это планировщик, а не журнал -- журнал
        // живёт в Archive/My completed tasks.
        setTasks(perProject.flat().filter(({ task }) => task.status !== 'archived'));
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить задачи.'))
      .finally(() => setLoading(false));
  }, []);

  // Реже, чем доска (5с): здесь на каждый цикл уходит N+1 запрос, а сквозной
  // экран смотрят, чтобы спланировать день, а не следить за чужим кликом.
  usePolling(load, 15000);

  return { tasks, projects, loading, loadError };
}

/**
 * Справочник организации для подстановки имён. Роли member он недоступен
 * (GET /api/users отвечает ей 403) -- это НАМЕРЕННО, поэтому 403 здесь не
 * ошибка экрана, а пустой справочник: подписи с именами просто не появятся.
 */
export function useOrgUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    getUsers()
      .then(setUsers)
      .catch((err) => {
        setUsers([]);
        setForbidden(err instanceof ApiError && err.status === 403);
      });
  }, []);

  return { users, forbidden };
}
