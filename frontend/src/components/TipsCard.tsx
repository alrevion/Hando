import { useState } from 'react';
import { X } from 'lucide-react';

const TIPS: Record<string, { title: string; lines: string[] }> = {
  assigned: {
    title: 'Как поручать',
    lines: [
      'Нажмите «+» и наговорите или напишите: «Азизу завтра до трёх подготовить отчёт».',
      'Проверьте черновик — кому, срок, важность — и нажмите «Создать».',
      'Адресат получит карточку в Telegram и ответит кнопками. Сданное принимайте здесь.',
    ],
  },
  tasks: {
    title: 'Как работать с задачами',
    lines: [
      'Зелёная стрелка ведёт по этапам: принял → начал → сдал на проверку.',
      '«Не успею» и «Отказать» — с одной фразой, автор получит её сразу.',
      'Напоминания приходят в Telegram: за час до срока, в срок и по графику.',
    ],
  },
};

const key = (screen: string) => `hando.tips.${screen}.v1`;

/** Подсказки первых шагов (раздел 23): закрываются и не возвращаются. */
export function TipsCard({ screen }: { screen: 'assigned' | 'tasks' }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key(screen)) === '1'; } catch { return false; } });
  const tip = TIPS[screen];
  if (hidden || !tip) return null;
  return (
    <div className="card tips" role="note">
      <div className="t-row" style={{ alignItems: 'flex-start' }}>
        <span className="grow">
          <span className="t-title">{tip.title}</span>
          <ol className="tips-list">{tip.lines.map((l) => <li key={l}>{l}</li>)}</ol>
        </span>
        <button type="button" className="btn-icon" aria-label="Скрыть подсказку" onClick={() => { try { localStorage.setItem(key(screen), '1'); } catch { /* приватный режим */ } setHidden(true); }}>
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
