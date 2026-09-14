import { useEffect, useState } from 'react';

import type { User } from '../types';
import { getMe } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { OrgJoinForm } from './OrgJoinForm';
import { Sheet } from './Sheet';

/**
 * Первая организация создаётся ЗДЕСЬ (раздел 18): сессия без организации
 * законна, и приложение обязано открываться с «создайте или вступите», а не
 * отправлять человека в бота.
 *
 * Форма -- в модальном окне, а не прямо на экране: так владелец описал шаги
 * («сверху переключатель, потом название, потом отрасль»), и то же окно
 * используется в профиле (см. ProfileSheet) -- один путь везде.
 */
export function NoOrgScreen({ user }: { user: User }) {
  const { setUser } = useAuth();
  const [info, setInfo] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const pending = user.pending ?? [];
  // Заявку подтверждают в чужом Telegram: опрашиваем, чтобы экран открылся сам.
  useEffect(() => {
    if (pending.length === 0) return;
    const id = setInterval(() => { getMe().then((r) => { if (r.user.org_id) setUser(r.user); }).catch(() => {}); }, 10000);
    return () => clearInterval(id);
  }, [pending.length, setUser]);
  return (
    <div className="app-frame" style={{ overflowY: 'auto' }}>
      <div style={{ padding: '32px 16px 40px', maxWidth: 520, margin: '0 auto', width: '100%' }}>
        <h1 className="h1">Здравствуйте, {user.name.split(' ')[0]}</h1>
        <p className="muted" style={{ marginBottom: 16 }}>
          Hando записывает поручения голосом, напоминает и принимает работу. Чтобы начать, нужно пространство — своя фирма, школа или просто семья.
        </p>
        {info ? <div role="status" className="alert alert-ok">{info}</div> : null}
        {pending.length > 0 ? (
          <div className="card" style={{ marginBottom: 12 }}>
            <span className="t-title">Заявка отправлена</span>
            <span className="t-meta"><span>{pending.join(', ')} — ждём подтверждения. Как примут, приложение откроется само.</span></span>
          </div>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Создать или вступить</button>
      </div>

      {open ? (
        <Sheet title="Создать или вступить" onClose={() => setOpen(false)}>
          <OrgJoinForm
            onCancel={() => setOpen(false)}
            onDone={async (kind, name) => {
              if (kind === 'requested') { setInfo(`Заявка в «${name}» отправлена. Ждём подтверждения.`); setOpen(false); return; }
              setOpen(false);
              setUser((await getMe()).user);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
