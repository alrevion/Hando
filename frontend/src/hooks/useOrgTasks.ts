import { useMemo } from 'react';
import type { Project, Task, User } from '../types';
import { useData } from '../context/DataContext';

// Задача вместе с названием своей доски. Сквозные экраны (Мои задачи, Люди,
// Календарь) показывают задачи вне контекста доски, и без названия проекта
// строка «Позвонить в банк» не говорит, откуда она взялась.
export interface OrgTask {
  task: Task;
  projectName: string;
}

/**
 * Задачи организации, доступные текущему человеку.
 *
 * Раньше здесь был свой запрос -- список досок плюс запрос на каждую, -- и своя
 * копия данных у каждого экрана. Переключение вкладки означало N+1 запросов и
 * «Загрузка…» поверх уже виденного. Теперь это ВЫБОРКА из общего склада
 * (DataContext): переключение вкладок сети не касается вовсе.
 *
 * Архивные сюда не попадают: это планировщик, а не журнал -- журнал живёт в
 * Archive/My completed tasks.
 */
export function useOrgTasks() {
  const { projects, tasks, ready, error } = useData();

  const rows = useMemo<OrgTask[]>(() => {
    const nameById = new Map(projects.map((p) => [p.id, p.name]));
    return tasks
      .filter((task) => task.status !== 'archived')
      .map((task) => ({ task, projectName: nameById.get(task.project_id) ?? '' }));
  }, [tasks, projects]);

  return { tasks: rows, projects: projects as Project[], loading: !ready, loadError: error };
}

/**
 * Справочник организации для подстановки имён. Роли member он недоступен --
 * это НАМЕРЕННО, поэтому пустой справочник здесь не ошибка экрана: подписи с
 * именами просто не появятся.
 */
export function useOrgUsers(): { users: User[]; forbidden: boolean } {
  const { users, canSeeUsers, ready } = useData();
  return { users, forbidden: ready && !canSeeUsers };
}
