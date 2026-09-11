// Тосты на действия: одна очередь на приложение, без контекста и провайдеров.
// Экран вызывает toast('Создано'), а <Toaster/> в оболочке показывает.
type Listener = (text: string) => void;
let listener: Listener | null = null;

export function toast(text: string): void {
  listener?.(text);
}

export function onToast(fn: Listener | null): void {
  listener = fn;
}
