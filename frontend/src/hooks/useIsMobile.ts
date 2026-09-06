import { useEffect, useState } from 'react';

/**
 * Узкий ли экран. Порог 1024px -- тот же, на котором в руководствах по
 * адаптивной навигации боковая панель уступает место нижней.
 *
 * Слушаем matchMedia, а не resize: он срабатывает только на пересечении порога,
 * а не на каждом пикселе, и переживает поворот экрана.
 */
export function useIsMobile(breakpoint = 1024): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : true);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);

  return mobile;
}
