import { useEffect, useState } from 'react';
import { ApiError, createOrg, getPacks, joinOrgByCode, type OrgPack } from '../lib/api';

const JOIN_ERROR: Record<string, string> = {
  unknown_code: 'Код не подошёл. Проверьте у того, кто его дал.',
  already_member: 'Вы уже в этой организации.',
  already_pending: 'Заявка уже подана, ждём подтверждения.',
};

/**
 * Создать организацию (название + профиль отрасли) или вступить по коду.
 * Одна форма для профиля и для экрана «создайте или вступите»: у первой
 * организации тот же путь, что у второй.
 */
export function OrgJoinForm({ onDone, onCancel }: { onDone: (kind: 'created' | 'requested', name: string) => Promise<void> | void; onCancel?: () => void }) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [packs, setPacks] = useState<OrgPack[]>([]);
  const [cats, setCats] = useState<{ id: string; title: string; emoji: string }[]>([]);
  const [chosenCat, setChosenCat] = useState('other');
  const [chosenPack, setChosenPack] = useState('generic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPacks().then((c) => { setPacks(c.industries); setCats(c.categories); }).catch(() => {});
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'create') {
        await createOrg(name.trim(), chosenPack);
        await onDone('created', name.trim());
      } else {
        const res = await joinOrgByCode(code.trim());
        await onDone('requested', res.org_name);
      }
    } catch (err) {
      const c = err instanceof ApiError ? err.code ?? err.message : '';
      setError(JOIN_ERROR[c] ?? (err instanceof ApiError ? err.message : 'Не получилось. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="chips" style={{ paddingBottom: 10 }}>
        <button type="button" className={mode === 'create' ? 'chip on' : 'chip'} onClick={() => setMode('create')}>Создать организацию</button>
        <button type="button" className={mode === 'join' ? 'chip on' : 'chip'} onClick={() => setMode('join')}>Вступить по коду</button>
      </div>
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

      {mode === 'create' ? (
        <>
          <div className="field">
            <label className="lbl" htmlFor="org-name">Как назвать</label>
            <input id="org-name" className="inp" autoFocus value={name} placeholder="Например, «Ромашка» или «Семья»" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <span className="lbl">Чем занимаетесь</span>
            <div className="chips" style={{ paddingBottom: 6 }}>
              {cats.map((k) => (
                <button key={k.id} type="button" className={chosenCat === k.id ? 'chip on' : 'chip'} onClick={() => {
                  setChosenCat(k.id);
                  const first = packs.find((p) => p.category === k.id);
                  if (first) setChosenPack(first.id);
                }}>
                  {k.emoji} {k.title}
                </button>
              ))}
            </div>
            <div className="chips" style={{ paddingBottom: 0 }}>
              {packs.filter((p) => p.category === chosenCat).map((p) => (
                <button key={p.id} type="button" className={chosenPack === p.id ? 'chip on' : 'chip'} onClick={() => setChosenPack(p.id)}>{p.title}</button>
              ))}
            </div>
            <p className="hint">Отделы: {(packs.find((p) => p.id === chosenPack)?.departments ?? []).join(', ')}</p>
          </div>
        </>
      ) : (
        <div className="field">
          <label className="lbl" htmlFor="org-code">Код организации</label>
          <input id="org-code" className="inp" autoFocus value={code} placeholder="Шесть символов" onChange={(e) => setCode(e.target.value)} />
          <p className="hint">Код даёт тот, кто вас зовёт. Или перейдите по его ссылке-приглашению в Telegram.</p>
        </div>
      )}

      <div className="btn-row">
        {onCancel ? <button type="button" className="btn" onClick={onCancel}>Отмена</button> : null}
        <button type="submit" className="btn btn-primary" disabled={busy || (mode === 'create' ? !name.trim() : !code.trim())}>
          {mode === 'create' ? 'Создать' : 'Подать заявку'}
        </button>
      </div>
    </form>
  );
}
