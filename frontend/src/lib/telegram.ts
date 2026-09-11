// Мост к мини-приложению Telegram.
//
// Telegram кладёт window.Telegram.WebApp только если страница загрузила его
// скрипт (см. index.html). Без него initData не появится, и приложение честно
// уйдёт на вход по телефону -- это и есть поведение в обычном браузере.
type WebApp = {
  initData: string;
  ready(): void;
  expand(): void;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent?(event: string, handler: () => void): void;
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
};

function webApp(): WebApp | null {
  const w = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  // Пустая строка initData бывает, когда страницу открыли не из Telegram, а по
  // прямой ссылке: скрипт есть, подписи нет.
  return w && typeof w.initData === 'string' && w.initData.length > 0 ? w : null;
}

/** Подписанные данные Telegram или null, если открыто не из мессенджера. */
export function initData(): string | null {
  return webApp()?.initData ?? null;
}

/**
 * Переносит тему Telegram в CSS-переменные.
 *
 * Мини-приложение обязано выглядеть частью мессенджера: у человека там тёмная
 * тема -- значит и здесь тёмная, причём ТЕХ ЖЕ оттенков. Своя палитра поверх
 * чужой темы читается как чужеродное окно.
 *
 * Значения по умолчанию -- на случай открытия в браузере, где themeParams нет.
 */
export function applyTelegramTheme(): void {
  const w = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  // Вне Telegram тему не навязываем: index.css сам следует системной
  // настройке через prefers-color-scheme.
  if (!w?.colorScheme) return;
  const p = w.themeParams;
  const dark = w.colorScheme === 'dark';
  const root = document.documentElement;

  // data-theme переключает набор токенов в index.css; color-scheme нужен
  // браузеру, чтобы системные элементы (скроллбары, поля ввода) не остались
  // светлыми на тёмном фоне.
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.dataset.theme = dark ? 'dark' : 'light';
  if (!p) return;

  const map: Record<string, string | undefined> = {
    '--tg-bg': p.bg_color,
    '--tg-text': p.text_color,
    '--tg-hint': p.hint_color,
    '--tg-link': p.link_color,
    '--tg-button': p.button_color,
    '--tg-button-text': p.button_text_color,
    '--tg-secondary-bg': p.secondary_bg_color,
    '--tg-section-bg': p.section_bg_color ?? p.bg_color,
    '--tg-separator': p.section_separator_color,
  };
  for (const [name, value] of Object.entries(map)) {
    if (value) root.style.setProperty(name, value);
  }
}

/** Сообщает Telegram, что приложение готово, и разворачивает его на весь экран. */
export function announceReady(): void {
  const w = webApp();
  if (!w) return;
  try {
    w.ready();
    w.expand();
    applyTelegramTheme();
    // Шапка и подложка самого Telegram вокруг нас -- того же цвета, что наша
    // страница (secondary_bg), иначе над стеклянной шапкой видна чужая полоса.
    w.setHeaderColor?.('secondary_bg_color');
    w.setBackgroundColor?.('secondary_bg_color');
    // Человек переключил тему мессенджера, не закрывая приложение.
    w.onEvent?.('themeChanged', applyTelegramTheme);
  } catch {
    // Старые клиенты могут не знать expand(); это не повод падать.
  }
}


// ------------------------------------------------------------ кнопка «назад»
//
// На Android системная кнопка «назад» ЗАКРЫВАЕТ мини-приложение -- если только
// не показана BackButton Telegram: тогда нажатие уходит в неё, а приложение
// остаётся открытым. Поэтому «назад» -- не украшение, а единственный способ не
// терять человека на первом же шаге вглубь.
//
// Стопка, а не флаг: шторка поверх подэкрана поверх вкладки -- три уровня, и
// «назад» обязан снимать ровно верхний. Каждый экран, который умеет
// закрываться, кладёт сюда свой обработчик и снимает его, когда уходит.

const stack: (() => void)[] = [];
let bound = false;

function pop(): void {
  const top = stack[stack.length - 1];
  if (top) top();
}

function sync(): void {
  const w = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  const b = w?.BackButton;
  if (!b) return;
  if (!bound) { b.onClick(pop); bound = true; }
  if (stack.length > 0) b.show();
  else b.hide();
}

/**
 * Кладёт обработчик «назад» и возвращает функцию снятия -- ровно то, что
 * возвращает useEffect. Порядок гарантирован стопкой: снимается последний
 * положенный, а не первый попавшийся.
 */
export function pushBack(handler: () => void): () => void {
  stack.push(handler);
  sync();
  return () => {
    const i = stack.lastIndexOf(handler);
    if (i >= 0) stack.splice(i, 1);
    sync();
  };
}
