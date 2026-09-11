import { useState } from 'react';
import type { User } from '../types';
import { getMe } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { OrgJoinForm } from './OrgJoinForm';

/**
 * Первая организация создаётся ЗДЕСЬ (раздел 18): сессия без организации
 * законна, и приложение обязано открываться с «создайте или вступите», а не
 * отправлять человека в бота.
 */
export function NoOrgScreen({ user }: { user: User }) {
  const { setUser } = useAuth();
  const [info, setInfo] = useState<string | null>(null);
  const pending = user.pending ?? [];
  return (
    <div className="app-frame" style={{ overflowY: 'auto' }}>
      <div style={{ padding: '32px 16px 40px', maxWidth: 520, margin: '0 auto', width: '100%' }}>
        <h1 className="h1">Здравствуйте, {user.name.split(' ')[0]}</h1>
        <p className="muted" style={{ marginBottom: 16 }}>
          Hando записывает поручения голосом, напоминает и принимает работу. Чтобы начать, нужна организация — своя фирма, школа или просто семья.
        </p>
        {info ? <div role="status" className="alert alert-ok">{info}</div> : null}
        {pending.length > 0 ? (
          <div className="card" style={{ marginBottom: 12 }}>
            <span className="t-title">Заявка отправлена</span>
            <span className="t-meta"><span>{pending.join(', ')} — ждём подтверждения. Как примут, приложение откроется само.</span></span>
          </div>
        ) : null}
        <div className="card">
          <OrgJoinForm onDone={async (kind, name) => {
            if (kind === 'requested') setInfo(`Заявка в «${name}» отправлена. Ждём подтверждения.`);
            setUser((await getMe()).user);
          }} />
        </div>
      </div>
    </div>
  );
}
