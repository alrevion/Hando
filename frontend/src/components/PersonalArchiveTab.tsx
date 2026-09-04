import { useEffect, useState } from 'react';
import type { ArchivedTaskEntry } from '../types';
import { ApiError, getMyArchive } from '../lib/api';

function formatDateTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// Read-only accountability view: tasks the signed-in admin was responsible
// for that are now done/archived. Restoring is a project-archive action
// (super_admin/creator), not exposed here.
export function PersonalArchiveTab() {
  const [entries, setEntries] = useState<ArchivedTaskEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMyArchive()
      .then((data) => {
        setEntries(data);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load your tasks.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">My completed tasks</h1>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-slate-500">No completed tasks yet.</p>
      ) : (
        <ul className="space-y-3">
          {entries.map(({ task, events }) => (
            <li key={task.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-medium text-slate-900">{task.title}</h2>
              {task.description ? <p className="text-xs text-slate-600">{task.description}</p> : null}
              <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                {events.map((event) => (
                  <li key={event.id} className="text-xs text-slate-500">
                    {event.action} · {formatDateTime(event.created_at)}
                    {event.overdue_by ? ` · overdue` : ''}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
