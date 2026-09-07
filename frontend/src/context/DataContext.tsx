import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project, Task, User } from '../types';
import { ApiError, getOrgSnapshot, getProjectMembers } from '../lib/api';

interface DataValue {
  projects: Project[];
  tasks: Task[];
  /** Справочник организации. Пуст, если роль его не видит (см. canSeeUsers). */
  users: User[];
  canSeeUsers: boolean;
  /** Первая загрузка завершена. «Загрузка…» показывается только до неё. */
  ready: boolean;
  error: string | null;
  /** Полный снимок. Вызывается после СВОИХ изменений -- вернёт и справочник. */
  refresh: () => Promise<void>;
  /** Люди конкретной доски. Ответ кэшируется: он нужен форме, а не ленте. */
  membersOf: (projectId: string) => Promise<User[]>;
}

const DataContext = createContext<DataValue | null>(null);

/** Как часто спрашивать изменения. Пока вкладка спрятана -- не спрашивать вовсе. */
const POLL_MS = 5000;

/**
 * Слияние по id. Возвращает ПРЕЖНИЙ массив, если ничего не приехало -- иначе
 * каждый опрос создавал бы новый массив, а с ним перерисовку всех экранов,
 * которые на него смотрят. Ровно из-за этого приложение и «подлагивало».
 *
 * Ушедшая в архив задача приезжает как обычное изменение и здесь же
 * выбрасывается: сервер её присылает специально, чтобы она не осталась висеть.
 */
function mergeTasks(prev: Task[], incoming: Task[]): Task[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((t) => [t.id, t]));
  let changed = false;
  for (const t of incoming) {
    if (t.status === 'archived') {
      changed = byId.delete(t.id) || changed;
      continue;
    }
    const old = byId.get(t.id);
    // Повтор той же строки -- обычное дело: у курсора есть запас в две секунды.
    if (old && old.updated_at === t.updated_at && JSON.stringify(old.assignees) === JSON.stringify(t.assignees)) continue;
    byId.set(t.id, t);
    changed = true;
  }
  if (!changed) return prev;
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** То же правило для досок: список меняется раз в месяц, ссылку зря не менять. */
function mergeProjects(prev: Project[], incoming: Project[]): Project[] {
  return JSON.stringify(prev) === JSON.stringify(incoming) ? prev : incoming;
}

/**
 * Единый склад данных организации.
 *
 * Раньше своя копия была у каждого экрана: переключение вкладки размонтировало
 * один и монтировало другой, и тот грузил всё заново -- список досок плюс
 * запрос на каждую, с надписью «Загрузка…» поверх уже виденных данных. Плюс три
 * независимых опроса одновременно.
 *
 * Теперь данные живут выше вкладок: переключение -- это только перерисовка, а с
 * сервера догружаются ТОЛЬКО изменения с прошлого раза (курсор `at`).
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [canSeeUsers, setCanSeeUsers] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Курсор последнего ответа и защита от наложения запросов: на медленной сети
  // ответ приходит позже следующего тика, и без флага они начинают гонку.
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);

  const pull = useCallback(async (full: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const snap = await getOrgSnapshot(full ? undefined : cursor.current ?? undefined);
      cursor.current = snap.at;
      setProjects((prev) => mergeProjects(prev, snap.projects));
      setTasks((prev) => (full ? snap.tasks.filter((t) => t.status !== 'archived') : mergeTasks(prev, snap.tasks)));
      // users приходит только с полным снимком; null -- «не менялся».
      if (snap.users) setUsers(snap.users);
      setCanSeeUsers(snap.can_see_users);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить данные.');
    } finally {
      inFlight.current = false;
      setReady(true);
    }
  }, []);

  const refresh = useCallback(() => pull(true), [pull]);

  useEffect(() => {
    pull(true);
    const tick = () => {
      // Спрятанная вкладка не опрашивается: это и трафик, и разряд батареи, и
      // очередь запросов, которая разом выстреливает при возвращении.
      if (!document.hidden) pull(false);
    };
    const id = setInterval(tick, POLL_MS);
    // Вернулись в приложение -- обновляемся сразу, не дожидаясь тика.
    const onVisible = () => { if (!document.hidden) pull(false); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pull]);

  // Люди доски нужны форме создания задачи, а не ленте, поэтому грузятся по
  // требованию и запоминаются: без кэша каждое открытие доски -- лишний запрос.
  const memberCache = useRef(new Map<string, Promise<User[]>>());
  const membersOf = useCallback((projectId: string) => {
    const cached = memberCache.current.get(projectId);
    if (cached) return cached;
    const p = getProjectMembers(projectId).catch(() => [] as User[]);
    memberCache.current.set(projectId, p);
    return p;
  }, []);

  return (
    <DataContext.Provider value={{ projects, tasks, users, canSeeUsers, ready, error, refresh, membersOf }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData(): DataValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}
