import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShowMore, usePaging } from './ShowMore';
import { ChevronDown } from 'lucide-react';
import type { Task, User } from '../types';
import { useOrgTasks, useOrgUsers, type OrgTask } from '../hooks/useOrgTasks';
import { PRIORITY_DOT } from '../lib/priority';
import { isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskMeta } from './TaskMeta';
import { assigneeKey } from '../lib/tasks';
import { MonthSheet } from './MonthSheet';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MAX_DOTS_PER_DAY = 3;
/** Сколько месяцев рисуется по обе стороны от выбранного. */
const SPAN = 6;
/** Ключ месяца для прокрутки к нему: «2026-09». */
const monthKey = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, '0')}`;

// Ключ дня -- первые 10 символов самой строки срока, а не Date. Сроки хранятся
// как YYYY-MM-DD, и new Date('2026-09-04') -- это полночь UTC: в западных
// часовых поясах задача уехала бы в календаре на день назад. Здесь сравнение
// строк и есть правильный ответ.
function dayKey(deadline: string): string {
  return deadline.slice(0, 10);
}

// «сентябрь 2026 г.» -> «Сентябрь 2026 г.»: CSS capitalize задел бы и «Г.».
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Внутренний календарь: ПРЕДСТАВЛЕНИЕ задач по датам. Не канал уведомлений и не
 * синхронизация с внешними календарями -- решение заказчика; уведомления жили и
 * живут в Telegram.
 *
 * Задача попадает в клетку своего срока. Задачи без срока в сетку не помещаются
 * в принципе, поэтому они не «теряются молча», а считаются отдельной строкой
 * под сеткой.
 */
export function CalendarView({ currentUser }: { currentUser: User }) {
  const { tasks: allTasks, projects, loading, loadError } = useOrgTasks();
  // МОИ по умолчанию. Календарь -- личный планировщик, и чем больше у человека
  // людей, тем бесполезнее он становится, если показывает сроки всего отдела
  // вперемешку со своими. «Все» остаётся рядом переключателем: обзор нужен, но
  // по требованию, а не постоянно.
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const tasks = useMemo(
    () => (scope === 'all'
      ? allTasks
      : allTasks.filter(({ task }) => task.author_id === currentUser.id
          || (task.assignees ?? []).some((a) => a.user_id === currentUser.id))),
    [allTasks, scope, currentUser.id],
  );
  const { users } = useOrgUsers();
  // ЯКОРЬ ленты и ВИДИМЫЙ месяц -- разные вещи, и в этом весь фокус. Якорь
  // задают только прыжки (шторка, «Сегодня»): вокруг него рисуется окно
  // месяцев, и только его смена прокручивает ленту. Видимый месяц меняет сама
  // прокрутка -- он живёт в подписи шапки. Будь это одно состояние, прокрутка
  // пересобирала бы окно и тут же отбрасывала палец в его середину.
  const [anchor, setAnchor] = useState(() => new Date());
  const [visible, setVisible] = useState(() => ({ y: anchor.getFullYear(), m: anchor.getMonth() }));
  const [viewing, setViewing] = useState<Task | null>(null);
  // Выбранный день: по умолчанию сегодня. Сетка на телефоне слишком узкая для
  // названий задач, поэтому в клетке -- только точки, а список -- под сеткой.
  const [selected, setSelected] = useState(() => localDayKey(new Date()));

  // Себя добавляем всегда: справочник организации роли member недоступен, и без
  // этого человек не увидел бы имени даже на собственной задаче.
  const usersById = useMemo(
    () => new Map<string, User>([[currentUser.id, currentUser], ...users.map((u) => [u.id, u] as const)]),
    [users, currentUser],
  );

  const [picking, setPicking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Год назад и год вперёд от якоря. Не бесконечная лента: дальше года мотать
  // пальцем дольше, чем выбрать месяц в шторке, а лишние сотни клеток в
  // разметке -- это лишние сотни клеток в разметке.
  const months = useMemo(
    () => Array.from({ length: SPAN * 2 + 1 }, (_, i) => {
      const d = new Date(anchor.getFullYear(), anchor.getMonth() - SPAN + i, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    }),
    [anchor],
  );

  const scrollTo = useCallback((y: number, m: number) => {
    const box = scroller.current;
    const target = box?.querySelector<HTMLElement>(`[data-month="${monthKey(y, m)}"]`);
    if (box && target) box.scrollTop = target.offsetTop - box.offsetTop;
    setVisible({ y, m });
  }, []);

  // Лента открывается на якорном месяце. Без плавности: это не переход, а
  // начальное положение.
  useEffect(() => {
    scrollTo(anchor.getFullYear(), anchor.getMonth());
  }, [anchor, scrollTo]);

  // Прыжок на месяц. Если он уже нарисован -- просто домотать: перестраивать
  // окно незачем. Если нет -- сменить якорь, и домотает useEffect.
  //
  // Разделение обязательное, а не красивое: «Сегодня» после прокрутки на
  // ноябрь оставляло ленту в ноябре. Якорь-то не менялся -- прокрутка его и не
  // трогает, -- а раз не менялся, то и эффект не срабатывал.
  const goto = (d: Date) => {
    const y = d.getFullYear();
    const m = d.getMonth();
    if (months.some((x) => x.y === y && x.m === m)) scrollTo(y, m);
    else setAnchor(d);
  };

  const byDay = useMemo(() => {
    const map = new Map<string, OrgTask[]>();
    for (const row of tasks) {
      if (!row.task.deadline) continue;
      const key = dayKey(row.task.deadline);
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return map;
  }, [tasks]);

  const undated = tasks.filter(({ task }) => !task.deadline).length;

  const todayKey = localDayKey(new Date());

  // Место выбранного дня в сетке месяца -- или null, если выбор не здесь.
  // Номер клетки, а не число: первая неделя сдвинута на день недели первого.
  const selIn = (y: number, m: number): number | null => {
    const [sy, sm, sd] = selected.split('-').map(Number);
    if (sy !== y || sm - 1 !== m) return null;
    return ((new Date(y, m, 1).getDay() + 6) % 7) + sd - 1;
  };

  const selectedTasks = byDay.get(selected) ?? [];
  // Счёт начинается заново на каждый выбранный день.
  const { shown, more } = usePaging(selected);
  const selectedDate = new Date(`${selected}T00:00:00`);

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Календарь</h1>

      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}

      {/* Чьи сроки в сетке. Показывается всем: у участника «все» -- это его
          отдел, у руководителя -- его поддерево, у владельца -- организация.
          Кому что видно, решает сервер одним правилом (hierarchy.visibleTasks). */}
      <div className="segmented" style={{ ['--n' as string]: 2 }} aria-label="Чьи задачи">
        <div className="segmented-indicator" aria-hidden="true" style={{ transform: `translateX(${scope === 'mine' ? 0 : 100}%)` }} />
        <button type="button" aria-pressed={scope === 'mine'} className={scope === 'mine' ? 'segmented-btn on' : 'segmented-btn'}
          onClick={() => setScope('mine')}>Мои</button>
        <button type="button" aria-pressed={scope === 'all'} className={scope === 'all' ? 'segmented-btn on' : 'segmented-btn'}
          onClick={() => setScope('all')}>Все</button>
      </div>

      <div className="card" style={{ padding: '12px 10px 10px' }}>
        <div className="t-row" style={{ alignItems: 'center', marginBottom: 6, padding: '0 4px' }}>
          {/* Заголовок -- КНОПКА: месяц и год выбираются колёсами, а не
              двенадцатью нажатиями на стрелку. Стрелок больше нет вовсе --
              месяцы листаются вниз, как лента. */}
          <button type="button" className="cal-jump grow" onClick={() => setPicking(true)}>
            {cap(new Date(visible.y, visible.m, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }))}
            <ChevronDown aria-hidden="true" />
          </button>
          {/* «Сегодня» возвращает и выбор, и прокрутку ленты. */}
          <button
            type="button"
            className={`btn btn-sm${selected === todayKey ? ' on' : ''}`}
            onClick={() => { const d = new Date(); goto(d); setSelected(localDayKey(d)); }}
          >
            Сегодня
          </button>
        </div>

        {/* Дни недели стоят НАД лентой и не уезжают с ней: подписи столбцов
            одни и те же во всех месяцах, и повторять их в каждом -- шум. */}
        <div className="cal cal-head">
          {WEEKDAYS.map((label) => <div key={label} className="cal-wd">{label}</div>)}
        </div>

        <div className="cal-scroll" ref={scroller} onScroll={(e) => {
          // Заголовок показывает тот месяц, что сейчас в ленте: иначе прокрутка
          // на три месяца вперёд оставляла бы в шапке старое название.
          const box = e.currentTarget;
          const mid = box.scrollTop + box.clientHeight / 3;
          for (const el of box.querySelectorAll<HTMLElement>('[data-month]')) {
            if (el.offsetTop - box.offsetTop + el.offsetHeight > mid) {
              const [y, m] = el.dataset.month!.split('-').map(Number);
              setVisible((prev) => (prev.y === y && prev.m === m - 1 ? prev : { y, m: m - 1 }));
              break;
            }
          }
        }}>
          {months.map(({ y, m }) => (
            <div key={monthKey(y, m)} data-month={monthKey(y, m)} className="cal-month">
              {/* Подпись месяца, чьё имя сейчас стоит в шапке, прячется -- но
                  занимает своё место: убери её из потока, и лента дёргалась бы
                  на высоту строки при каждом переходе через границу месяца. */}
              <div className="cal-cap" style={visible.y === y && visible.m === m ? { visibility: 'hidden' } : undefined}>
                {cap(new Date(y, m, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }))}
              </div>
              <div className="cal">
                {/* Пилюля -- отдельный элемент, который ЕЗЖАЕТ между клетками:
                    заливка у самой клетки переехать не может, она либо есть,
                    либо нет. Рисуется только в том месяце, где стоит выбор, --
                    прыжок через полгода ленты анимировать нечего. */}
                {selIn(y, m) !== null ? (
                  <div className="cal-pill" aria-hidden="true"
                    style={{ ['--pill-col' as string]: selIn(y, m)! % 7, ['--pill-row' as string]: Math.floor(selIn(y, m)! / 7) }} />
                ) : null}
                {Array.from({ length: (new Date(y, m, 1).getDay() + 6) % 7 }, (_, i) => <div key={`pad-${i}`} />)}
                {Array.from({ length: new Date(y, m + 1, 0).getDate() }, (_, i) => i + 1).map((day) => {
                  const key = localDayKey(new Date(y, m, day));
                  const dayTasks = byDay.get(key) ?? [];
                  const cls = ['cal-day', key === todayKey ? 'is-today' : '', key === selected ? 'is-sel' : ''].filter(Boolean).join(' ');
                  return (
                    <button key={key} type="button" className={cls} aria-pressed={key === selected} onClick={() => setSelected(key)}>
                      <span className="cal-n">{day}</span>
                      <span className="cal-dots" aria-hidden="true">
                        {dayTasks.slice(0, MAX_DOTS_PER_DAY).map(({ task }) => (
                          <span key={task.id} className={`dot ${isTaskOverdue(task) ? 'bg-red-500' : PRIORITY_DOT[task.priority]}`} />
                        ))}
                        {dayTasks.length > MAX_DOTS_PER_DAY ? <span className="cal-more">+</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {picking ? (
        <MonthSheet year={visible.y} month={visible.m}
          onPick={(y, m) => goto(new Date(y, m, 1))}
          onClose={() => setPicking(false)} />
      ) : null}

      <h2 className="sec-title">
        {cap(selectedDate.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }))}
      </h2>
      {loading ? (
        <p className="muted">Загрузка…</p>
      ) : selectedTasks.length === 0 ? (
        <p className="muted" style={{ padding: '4px 4px 0' }}>На этот день сроков нет.</p>
      ) : (
        <ul className="stack">
          {selectedTasks.slice(0, shown).map(({ task, projectName }) => {
            const overdue = isTaskOverdue(task);
            const who = usersById.get(assigneeKey(task))?.name ?? task.assignees?.[0]?.user_name;
            return (
              <li key={task.id}>
                <button type="button" onClick={() => setViewing(task)} className={`card card-tap${overdue ? ' is-overdue' : ''}`}>
                  <span className="grow">
                    <span className="t-title">{task.title}</span>
                    <TaskMeta
                      task={task}
                      projectName={projectName}
                      showProject={projects.length > 1}
                      who={who ? [{ name: who }] : undefined}
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ShowMore total={selectedTasks.length} shown={shown} onMore={more} />

      {undated > 0 ? (
        <p className="hint" style={{ marginTop: 14 }}>Без срока: {undated} — такие задачи в сетку не попадают.</p>
      ) : null}

      {viewing ? (
        <TaskDetailModal
          task={viewing}
          responsible={usersById.get(assigneeKey(viewing))}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}
