// Тосты на действия: одна очередь на приложение, без контекста и провайдеров.
// Экран вызывает toast('Создано'), а <Toaster/> в оболочке показывает.
type Listener = (text: string) => void;
let listener: Listener | null = null;

export function toast(text: string): void {
  listener?.(text);
}

/** Возвращает отписку, которая снимает только СВОЙ слушатель. */
export function onToast(fn: Listener): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}
