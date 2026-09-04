import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, Loader2 } from 'lucide-react';
import type { Project } from '../types';
import { ApiError, getArchivedProjects, restoreProject } from '../lib/api';

function formatDateTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

interface ArchivedProjectsViewProps {
  onRestored: () => void; // tells the sidebar to reload the active project list
}

// A project "delete" is really an archive (backend never hard-deletes one) --
// this is the other half of that loop: see what's archived, bring it back.
export function ArchivedProjectsView({ onRestored }: ArchivedProjectsViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getArchivedProjects()
      .then((data) => {
        setProjects(data);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load archived projects.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function handleRestore(project: Project) {
    setRestoringId(project.id);
    try {
      await restoreProject(project.id);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
      onRestored();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not restore that project.');
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Archived projects</h1>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-slate-500">No archived projects.</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-4"
            >
              <div className="min-w-0">
                <h2 className="truncate text-sm font-medium text-slate-900">{p.name}</h2>
                {p.archived_at ? <p className="text-xs text-slate-500">Archived {formatDateTime(p.archived_at)}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => handleRestore(p)}
                disabled={restoringId === p.id}
                className="flex shrink-0 items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {restoringId === p.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
