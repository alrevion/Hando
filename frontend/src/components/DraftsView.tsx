import { useCallback, useEffect, useState } from 'react';
import type { User } from '../types';
import { getDrafts, type DraftView } from '../lib/api';
import { useData } from '../context/DataContext';
import { DraftCard } from './DraftCard';
import { toast } from '../lib/toast';

/** Черновики -- те же, что кнопка «Черновики» в боте: продиктовано, но не подтверждено. */
export function DraftsView({ me }: { me: User }) {
  const { users, refresh } = useData();
  const [drafts, setDrafts] = useState<DraftView[] | null>(null);
  const load = useCallback(() => { getDrafts().then(setDrafts).catch(() => setDrafts([])); }, []);
  useEffect(load, [load]);
  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Черновики</h1>
      {drafts === null ? <p className="muted">Загрузка…</p> : drafts.length === 0 ? (
        <div className="empty"><b>Черновиков нет</b>Продиктованное и не подтверждённое ждёт здесь и в боте.</div>
      ) : (
        <ul className="stack">
          {drafts.map((d) => (
            <li key={d.id}>
              <DraftCard draft={d} users={users} me={me}
                onCreated={async () => { toast('Поручение создано'); load(); await refresh(); }}
                onDeleted={() => { toast('Черновик удалён'); load(); }} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
