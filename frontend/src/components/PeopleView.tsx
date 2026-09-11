import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Search, Snowflake, Trash2, X } from 'lucide-react';
import type { Task, User } from '../types';
import { useOrgTasks, useOrgUsers, type OrgTask } from '../hooks/useOrgTasks';
import { isTaskOverdue } from '../lib/overdue';
import { ApiError, approveMember, freezeUser, getOrgPositions, getPendingMembers, getUserStats, rejectMember, removeOrgMember, unfreezeUser, updateUser, type PendingMember, type PersonStats } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { toast } from '../lib/toast';
import type { Role } from '../types';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskMeta } from './TaskMeta';
import { isMine } from '../lib/tasks';

const STAGE_LABEL: Record<'todo' | 'in_progress' | 'done', string> = {
  todo: 'Не начато',
  in_progress: 'В работе',
  done: 'На проверке',
};

interface PersonRow {
  user: User;
  todo: OrgTask[];
  in_progress: OrgTask[];
  done: OrgTask[]; // сдано, но ещё не подтверждено -- этап руководителя, не сотрудника
  overdue: number;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

/**
 * Экран руководителя: кто на каком этапе. Одна карточка на человека и три этапа
 * в ней -- это и есть «полная картина»: доска показывает этапы одного проекта,
 * а вопрос руководителя («у кого что висит») ставится по людям и всегда
 * пересекает доски.
 *
 * Люди берутся из справочника организации, а не из задач: человек без задач --
 * это тоже ответ, и в списке задач его не видно.
 */
export function PeopleView() {
  const { tasks, projects, loading, loadError } = useOrgTasks();
  const { users, forbidden } = useOrgUsers();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ task: Task; responsible: User | undefined } | null>(null);
  // Заявки на вступление. 403 -- это не ошибка, а ответ «вы не владелец»:
  // список просто не появляется.
  const [pending, setPending] = useState<PendingMember[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { user: me } = useAuth();
  const { refresh } = useData();
  const [query, setQuery] = useState('');
  // Аналитика по человеку грузится при раскрытии карточки, а не на весь список.
  const [stats, setStats] = useState<Record<string, { all: PersonStats; last30: PersonStats }>>({});
  const canManage = !!me && me.role !== 'member';
  async function manage(userId: string, fn: () => Promise<unknown>, done: string) {
    setBusyId(userId);
    try { await fn(); toast(done); await refresh(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); } finally { setBusyId(null); }
  }
  // Кем и куда принять. Выбор живёт на карточке заявки, а не в отдельном
  // окне: это одно действие в два касания, а не настройка.
  const [choice, setChoice] = useState<Record<string, { role: Role; project?: string; position?: string }>>({});
  const [positions, setPositions] = useState<string[]>([]);
  const loadPending = useCallback(() => { getPendingMembers().then(setPending).catch(() => setPending([])); }, []);
  useEffect(loadPending, [loadPending]);
  // Должности берутся из профиля организации: у школы это «Завуч», у стройки
  // «Прораб». Печатать их руками каждый раз незачем.
  useEffect(() => { getOrgPositions().then(setPositions).catch(() => setPositions([])); }, []);

  async function decide(userId: string, ok: boolean) {
    setBusyId(userId);
    const c = choice[userId] ?? { role: 'member' as Role };
    try {
      await (ok
        ? approveMember(userId, { role: c.role, project_id: c.project ?? projects[0]?.id, position: c.position })
        : rejectMember(userId));
    } finally {
      setBusyId(null);
      loadPending();
    }
  }

  // Ролей три (решение 10.09): владельца с кнопки не выдают.
  const ROLES: { value: Role; label: string }[] = [
    { value: 'member', label: 'Участник' },
    { value: 'admin', label: 'Руководитель отдела' },
  ];
  const ROLE_NAME: Record<string, string> = { creator: 'Владелец', super_admin: 'Руководитель', admin: 'Руководитель отдела', member: 'Участник' };

  const rows = useMemo<PersonRow[]>(() => {
    const q = query.trim().toLowerCase();
    const list = users.filter((u) => !q || u.name.toLowerCase().includes(q) || (u.position ?? '').toLowerCase().includes(q)).map((user) => {
      const own = tasks.filter(({ task }) => isMine(task, user.id));
      return {
        user,
        todo: own.filter(({ task }) => task.status === 'todo'),
        in_progress: own.filter(({ task }) => task.status === 'in_progress'),
        // Подтверждённое сюда не попадает: этап закрыт, руководителю там делать нечего.
        done: own.filter(({ task }) => task.status === 'done' && !task.confirmed_at),
        overdue: own.filter(({ task }) => isTaskOverdue(task)).length,
      };
    });
    // Наверх -- те, у кого горит: просрочки, потом объём в работе. Алфавит
    // остаётся последним ключом, чтобы порядок не прыгал при равных числах.
    return list.sort(
      (a, b) =>
        b.overdue - a.overdue ||
        b.in_progress.length - a.in_progress.length ||
        a.user.name.localeCompare(b.user.name),
    );
  }, [tasks, users, query]);

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Люди</h1>

      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}
      {forbidden ? <div role="alert" className="alert alert-warn">Список людей недоступен.</div> : null}
      <div className="field" style={{ marginBottom: 10 }}>
        <div className="t-row" style={{ alignItems: 'center', gap: 8 }}>
          <Search aria-hidden="true" style={{ width: 16, height: 16, color: 'var(--label3)', flexShrink: 0 }} />
          <input className="inp grow" aria-label="Найти человека" placeholder="Найти человека" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {/* Заявки выше списка: это единственное, что здесь требует решения. */}
      {pending.length > 0 ? (
        <>
          <h2 className="sec-title" style={{ marginTop: 0 }}>Просятся в организацию</h2>
          <ul className="stack" style={{ marginBottom: 6 }}>
            {pending.map((p) => {
              const c = choice[p.user_id] ?? { role: 'member' as Role };
              const set = (patch: Partial<typeof c>) =>
                setChoice((prev) => ({ ...prev, [p.user_id]: { ...c, ...patch } }));
              return (
              <li key={p.user_id} className="card">
                <div className="t-row" style={{ alignItems: 'center' }}>
                  <span className="avatar avatar-lg">{initials(p.name) || '·'}</span>
                  <span className="grow">
                    <span className="t-title">{p.name}</span>
                    {p.telegram_username ? <span className="t-meta"><span>@{p.telegram_username}</span></span> : null}
                  </span>
                </div>

                {/* Кем принять -- вопрос обязательный: молчаливый «сотрудник»
                    и был тем, из-за чего роль приходилось менять потом. */}
                <div className="sec-title" style={{ margin: '10px 0 6px' }}>Кем принять</div>
                <div className="chips" style={{ paddingBottom: 6 }}>
                  {ROLES.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      className={c.role === r.value ? 'chip on' : 'chip'}
                      onClick={() => set({ role: r.value })}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>

                {projects.length > 1 ? (
                  <>
                    <div className="sec-title" style={{ margin: '4px 0 6px' }}>В какой отдел</div>
                    <div className="chips" style={{ paddingBottom: 6 }}>
                      {projects.map((pr) => (
                        <button
                          key={pr.id}
                          type="button"
                          className={(c.project ?? projects[0]?.id) === pr.id ? 'chip on' : 'chip'}
                          onClick={() => set({ project: pr.id })}
                        >
                          {pr.name}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}

                {positions.length > 0 ? (
                  <div className="field" style={{ marginBottom: 4 }}>
                    <label className="lbl" htmlFor={`pos-${p.user_id}`}>Должность</label>
                    <select
                      id={`pos-${p.user_id}`}
                      className="inp"
                      value={c.position ?? ''}
                      onChange={(e) => set({ position: e.target.value || undefined })}
                    >
                      <option value="">Не указывать</option>
                      {positions.map((pos) => <option key={pos} value={pos}>{pos}</option>)}
                    </select>
                  </div>
                ) : null}

                <div className="btn-row">
                  <button type="button" className="btn btn-primary" disabled={busyId === p.user_id} onClick={() => decide(p.user_id, true)}>
                    <Check aria-hidden="true" style={{ width: 16, height: 16 }} />
                    Принять
                  </button>
                  <button type="button" className="btn" disabled={busyId === p.user_id} onClick={() => decide(p.user_id, false)}>
                    <X aria-hidden="true" style={{ width: 16, height: 16 }} />
                    Отклонить
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
          <h2 className="sec-title">В организации</h2>
        </>
      ) : null}

      {loading ? (
        <p className="muted">Загрузка…</p>
      ) : rows.length === 0 ? (
        <div className="empty">
          <b>В организации пока никого нет</b>
          Пришлите сотруднику код организации из бота -- он появится здесь.
        </div>
      ) : (
        <ul className="stack">
          {rows.map((row) => {
            const expanded = expandedId === row.user.id;
            const active = [...row.todo, ...row.in_progress, ...row.done];
            return (
              <li key={row.user.id} className="card" style={{ padding: 0 }}>
                <button
                  type="button"
                  onClick={() => {
                    setExpandedId(expanded ? null : row.user.id);
                    if (!expanded && !stats[row.user.id]) getUserStats(row.user.id).then((st) => setStats((p) => ({ ...p, [row.user.id]: st }))).catch(() => {});
                  }}
                  aria-expanded={expanded}
                  className="card card-tap"
                  style={{ boxShadow: 'none' }}
                >
                  <span className="t-row" style={{ alignItems: 'center' }}>
                    <span className="avatar avatar-lg">{initials(row.user.name) || '·'}</span>
                    <span className="grow">
                      <span className="t-title">{row.user.name}</span>
                      <span className="t-meta">
                        <span>{row.user.position || ROLE_NAME[row.user.role] || ''}</span>
                        {row.user.frozen_at ? <span className="c-orange">заморожен</span> : null}
                        {/* Без Telegram-хэндла человека нельзя ни упомянуть, ни довести
                            до него уведомление -- на экране руководителя это такой же
                            факт о ходе работы, как счётчики этапов. */}
                        {row.user.telegram_username ? null : <span className="c-orange">не подключён</span>}
                      </span>
                      {/* Нули не показываем: «В работе · 0» -- шум, а не факт. */}
                      {active.length === 0 ? (
                        <span className="t-meta"><span>Активных задач нет</span></span>
                      ) : (
                        <span className="pills">
                          {row.overdue > 0 ? <span className="pill pill-red">просрочено · {row.overdue}</span> : null}
                          {row.in_progress.length > 0 ? <span className="pill pill-blue">{STAGE_LABEL.in_progress} · {row.in_progress.length}</span> : null}
                          {row.todo.length > 0 ? <span className="pill">{STAGE_LABEL.todo} · {row.todo.length}</span> : null}
                          {row.done.length > 0 ? <span className="pill pill-green">{STAGE_LABEL.done} · {row.done.length}</span> : null}
                        </span>
                      )}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      style={{
                        width: 18, height: 18, flexShrink: 0, color: 'var(--label4)',
                        transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s',
                      }}
                    />
                  </span>
                </button>

                {expanded ? (
                  <div style={{ borderTop: '0.5px solid var(--sep)', padding: '10px 12px 4px' }}>
                    {(() => {
                      const st = stats[row.user.id];
                      if (!st) return <p className="muted" style={{ fontSize: 13 }}>Считаю…</p>;
                      const line = (label: string, s: PersonStats) => (
                        <div key={label} className="t-meta" style={{ display: 'block', marginBottom: 4 }}>
                          <b>{label}:</b> сдано {s.done}{s.on_time_pct !== null ? ` · в срок ${s.on_time_pct}%` : ''}{s.avg_late_days > 0 ? ` · просрочка ${s.avg_late_days} дн.` : ''} · принял {s.accepted} · отказался {s.declined} · в работе {s.in_progress}
                        </div>
                      );
                      return <>{line('30 дней', st.last30)}{line('Всё время', st.all)}</>;
                    })()}
                    {canManage && me && row.user.id !== me.id && row.user.role !== 'creator' ? (
                      <div className="btn-row" style={{ marginTop: 8 }}>
                        <select className="inp" style={{ width: 'auto', padding: '6px 10px' }} aria-label="Роль" value={row.user.role === 'super_admin' ? 'admin' : row.user.role} disabled={busyId === row.user.id}
                          onChange={(e) => manage(row.user.id, () => updateUser(row.user.id, { role: e.target.value as 'admin' | 'member' }), 'Роль изменена')}>
                          {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                        <button type="button" className="btn btn-sm" disabled={busyId === row.user.id}
                          onClick={() => manage(row.user.id, () => (row.user.frozen_at ? unfreezeUser(row.user.id) : freezeUser(row.user.id)), row.user.frozen_at ? 'Разморожен' : 'Заморожен, поручения вернулись авторам')}>
                          <Snowflake aria-hidden="true" style={{ width: 14, height: 14 }} />{row.user.frozen_at ? 'Разморозить' : 'Заморозить'}
                        </button>
                        <button type="button" className="btn btn-sm btn-danger" disabled={busyId === row.user.id}
                          onClick={() => { if (me.org_id && window.confirm(`Удалить ${row.user.name} из организации? История сохранится.`)) void manage(row.user.id, () => removeOrgMember(me.org_id as string, row.user.id), 'Удалён'); }}>
                          <Trash2 aria-hidden="true" style={{ width: 14, height: 14 }} />Удалить
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {expanded ? (
                  <ul style={{ borderTop: '0.5px solid var(--sep)', padding: '6px 8px 8px' }}>
                    {active.length === 0 ? (
                      <li className="muted" style={{ padding: '8px 8px 4px' }}>Активных задач нет.</li>
                    ) : (
                      active.map(({ task, projectName }) => (
                          <li key={task.id}>
                            <button
                              type="button"
                              onClick={() => setViewing({ task, responsible: row.user })}
                              className="card card-tap"
                              style={{ boxShadow: 'none', padding: '10px 8px', background: 'transparent' }}
                            >
                              <span className="grow">
                                <span className="t-title" style={{ fontSize: 15, fontWeight: 500 }}>{task.title}</span>
                                <TaskMeta task={task} projectName={projectName} showProject={projects.length > 1} line />
                              </span>
                            </button>
                          </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {viewing ? (
        <TaskDetailModal task={viewing.task} responsible={viewing.responsible} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}
