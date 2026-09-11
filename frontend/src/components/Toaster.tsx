import { useEffect, useState } from 'react';
import { onToast } from '../lib/toast';

/** Один тост за раз, 2,5 секунды, поверх дока. aria-live -- чтобы читалки услышали. */
export function Toaster() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const off = onToast((t) => {
      setText(t);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setText(null), 2500);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, []);
  return (
    <div className="toast-host" aria-live="polite">
      {text ? <div className="toast">{text}</div> : null}
    </div>
  );
}
