import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ArchivedTaskEntry, Task, User } from '../types';
import { ApiError, getMyArchive, getProjectArchive, restoreTask } from '../lib/api';
import { useData } from '../context/DataContext';
import { toast } from '../lib/toast';
import { AskText } from './AskText';

const ACTION: Record<string, string> = {
  created: 'создано', moved_in_progress: 'в работе', moved_done: 'сдано', moved_todo: 'возвращено', moved_archived: 'в архив',
  confirmed: 'принято', rejected: 'возвращено на доработку', archived: 'архив (автоматически)', deleted: 'удалено', restored: 'восстановлено',
  edited: 'правка', edited_reopened: 'правка, заново', reassigned: 'переназначено', returned: 'вернулось автору', assignee_changed: 'ход работы',
};

function when(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Архив: сданное и закрытое с журналом -- кто что и когда. Своё видит каждый;
 * владелец -- архив всех досок и может вернуть задачу в работу.
 */
export function ArchiveView({ user }: { user: User }) {
  const { projects, refresh } = useData();
  const [mine, setMine] = useState<ArchivedTaskEntry[] | null>(null);
  const [org, setOrg] = useState<Record<string, ArchivedTaskEntry[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Task | null>(null);
  const owner = user.role === 'creator' || user.role === 'super_admin';

  useEffect(() => {
    getMyArchive().then(setMine).catch((err) => { setError(err instanceof ApiError ? err.message : 'Не удалось загрузить.'); setMine([]); });
  }, []);
  useEffect(() => {
    if (!owner) return;
    for (const p of projects) {
      getProjectArchive(p.id).then((a) => setOrg((prev) => ({ ...prev, [p.id]: a.archivedTasks }))).catch(() => {});
    }
  }, [owner, projects]);

  const entry = (e: ArchivedTaskEntry, restorable: boolean) => (
    <li key={e.task.id} className="card">
      <span className="t-title">{e.task.title}</span>
      <span className="t-meta"><span>{e.task.status === 'archived' ? 'в архиве' : e.task.confirmed_at ? 'принято' : 'сдано, на проверке'}</span></span>
      <ul className="tips-list" style={{ marginTop: 8, paddingLeft: 0, listStyle: 'none' }}>
        {e.events.slice(0, 6).map((ev) => (
          <li key={ev.id} className="muted" style={{ fontSize: 13 }}>
            {when(ev.created_at)} · {ACTION[ev.action] ?? ev.action}{ev.actor_name ? ` · ${ev.actor_name}` : ''}{ev.comment ? ` — ${ev.comment}` : ''}
          </li>
        ))}
      </ul>
      {restorable && e.task.status === 'archived' ? (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={() => setRestoring(e.task)}>
            <RotateCcw aria-hidden="true" style={{ width: 14, height: 14 }} />Вернуть в работу
          </button>
        </div>
      ) : null}
    </li>
  );

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Архив</h1>
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}
      <h2 className="sec-title">Моё сданное и закрытое</h2>
      {mine === null ? <p className="muted">Загрузка…</p> : mine.length === 0 ? <p className="muted">Пока пусто.</p> : (
        <ul className="stack">{mine.map((e) => entry(e, false))}</ul>
      )}
      {owner ? projects.map((p) => {
        const list = org[p.id];
        if (!list || list.length === 0) return null;
        return (
          <section key={p.id}>
            <h2 className="sec-title">Архив · {p.name}</h2>
            <ul className="stack">{list.map((e) => entry(e, true))}</ul>
          </section>
        );
      }) : null}
      {restoring ? (
        <AskText title={`Вернуть «${restoring.title}» в работу?`} placeholder="Комментарий — почему возвращаем" submitLabel="Вернуть"
          onSubmit={async (text) => {
            await restoreTask(restoring.id, text);
            toast('Возвращено в работу');
            await refresh();
            const a = await getProjectArchive(restoring.project_id).catch(() => null);
            if (a) setOrg((prev) => ({ ...prev, [restoring.project_id]: a.archivedTasks }));
          }}
          onClose={() => setRestoring(null)} />
      ) : null}
    </div>
  );
}
