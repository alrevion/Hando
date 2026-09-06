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

/** Сообщает Telegram, что приложение готово, и разворачивает его на весь экран. */
export function announceReady(): void {
  const w = webApp();
  if (!w) return;
  try {
    w.ready();
    w.expand();
  } catch {
    // Старые клиенты могут не знать expand(); это не повод падать.
  }
}
