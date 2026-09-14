import { useEffect, useState, type CSSProperties } from 'react';
import { ApiError, createOrg, getPacks, joinOrgByCode, type OrgPack } from '../lib/api';

const JOIN_ERROR: Record<string, string> = {
  unknown_code: 'Код не подошёл. Проверьте у того, кто его дал.',
  already_member: 'Вы уже в этом пространстве.',
  already_pending: 'Заявка уже подана, ждём подтверждения.',
};

/**
 * Создать организацию (название + профиль отрасли) или вступить по коду.
 * Одна форма для профиля и для экрана «создайте или вступите»: у первой
 * организации тот же путь, что у второй.
 *
 * Сверху -- сегментный переключатель: тот же приём, что у нижней навигации
 * (.nav-indicator в BottomNav) -- одна подложка едет между двумя кнопками,
 * а не гаснет одна и загорается другая.
 *
 * Ветка «создать» -- в два шага (сперва название, потом отрасль), а не одной
 * длинной формой: так её и описал владелец, и это же развело в разные экраны
 * то, что раньше слипалось в один сплошной бланк.
 */
export function OrgJoinForm({ onDone, onCancel }: { onDone: (kind: 'created' | 'requested', name: string) => Promise<void> | void; onCancel?: () => void }) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [step, setStep] = useState<1 | 2>(1);
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

  function switchMode(next: 'create' | 'join') {
    setMode(next);
    setStep(1);
    setError(null);
  }

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
    <form onSubmit={(e) => { e.preventDefault(); if (mode === 'create' && step === 1) { setStep(2); return; } void submit(); }}>
      <div className="segmented" style={{ '--n': 2 } as CSSProperties}>
        <div className="segmented-indicator" aria-hidden="true" style={{ transform: `translateX(${mode === 'create' ? 0 : 100}%)` }} />
        <button type="button" className={mode === 'create' ? 'segmented-btn on' : 'segmented-btn'} aria-pressed={mode === 'create'} onClick={() => switchMode('create')}>Создать</button>
        <button type="button" className={mode === 'join' ? 'segmented-btn on' : 'segmented-btn'} aria-pressed={mode === 'join'} onClick={() => switchMode('join')}>Вступить по коду</button>
      </div>

      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

      {mode === 'create' ? (
        step === 1 ? (
          <>
            <div className="field">
              <label className="lbl" htmlFor="org-name">Как назвать</label>
              <input id="org-name" className="inp" autoFocus value={name} placeholder="Например, «Ромашка» или «Семья»" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="btn-row">
              {onCancel ? <button type="button" className="btn" onClick={onCancel}>Отмена</button> : null}
              <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Далее</button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <span className="lbl">Чем занимаетесь</span>
              {/* Список с прокруткой, а не строка чипов: категорий пятнадцать,
                  в одну строку помещались три первые, остальные терялись за
                  краем экрана и выглядели так, будто их всего три.
                  Рамка выбранного -- INSET: внешняя рисуется за границами
                  кнопки, и прокрутка срезала её слева, справа и по краям
                  списка -- выделение выглядело обрубленным. */}
              <div className="stack" style={{ gap: 6, maxHeight: 260, overflowY: 'auto', marginBottom: 10 }}>
                {cats.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    className="card card-tap"
                    aria-pressed={chosenCat === k.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, ...(chosenCat === k.id ? { boxShadow: 'inset 0 0 0 1.5px var(--accent)' } : null) }}
                    onClick={() => {
                      setChosenCat(k.id);
                      const first = packs.find((p) => p.category === k.id);
                      if (first) setChosenPack(first.id);
                    }}
                  >
                    <span aria-hidden="true">{k.emoji}</span>
                    <span className="t-title">{k.title}</span>
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
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => setStep(1)}>Назад</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Создать</button>
            </div>
          </>
        )
      ) : (
        <>
          <div className="field">
            <label className="lbl" htmlFor="org-code">Код пространства</label>
            <input id="org-code" className="inp" autoFocus value={code} placeholder="Шесть символов" onChange={(e) => setCode(e.target.value)} />
            <p className="hint">Код даёт тот, кто вас зовёт. Или перейдите по его ссылке-приглашению в Telegram.</p>
          </div>
          <div className="btn-row">
            {onCancel ? <button type="button" className="btn" onClick={onCancel}>Отмена</button> : null}
            <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>Подать заявку</button>
          </div>
        </>
      )}
    </form>
  );
}
