import { useEffect, useRef, useState, type MouseEvent, type TouchEvent, type WheelEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

interface LightboxImage {
  src: string;
  alt?: string;
}

interface LightboxProps {
  images: LightboxImage[];
  startIndex: number;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const SWIPE_THRESHOLD = 60;

function touchDistance(touches: TouchList | React.TouchList) {
  const a = touches[0];
  const b = touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

// Fullscreen photo viewer: left/right nav (buttons + arrow keys + swipe),
// zoom via trackpad pinch / ctrl+scroll / touch pinch, drag-to-pan once zoomed,
// double-click/tap to toggle zoom. No external lib -- the gesture math is small
// enough that pulling one in wasn't worth it.
export function Lightbox({ images, startIndex, onClose }: LightboxProps) {
  const [index, setIndex] = useState(startIndex);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const swipeStartX = useRef<number | null>(null);

  function reset() {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }

  function go(delta: number) {
    setIndex((i) => Math.min(Math.max(i + delta, 0), images.length - 1));
    reset();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.length]);

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return; // trackpad pinch (and ctrl+scroll) only -- plain scroll does nothing
    e.preventDefault();
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s - e.deltaY * 0.01)));
  }

  function toggleZoom() {
    if (scale > 1) reset();
    else setScale(2.5);
  }

  function onMouseDown(e: MouseEvent) {
    if (scale <= 1) return;
    dragging.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }
  function onMouseMove(e: MouseEvent) {
    if (!dragging.current) return;
    setPos({ x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y });
  }
  function endDrag() {
    dragging.current = null;
  }

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
      pinch.current = { dist: touchDistance(e.touches), scale };
    } else if (e.touches.length === 1) {
      if (scale > 1) dragging.current = { x: e.touches[0].clientX - pos.x, y: e.touches[0].clientY - pos.y };
      else swipeStartX.current = e.touches[0].clientX;
    }
  }
  function onTouchMove(e: TouchEvent) {
    if (e.touches.length === 2 && pinch.current) {
      const ratio = touchDistance(e.touches) / pinch.current.dist;
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinch.current.scale * ratio)));
    } else if (e.touches.length === 1 && dragging.current) {
      setPos({ x: e.touches[0].clientX - dragging.current.x, y: e.touches[0].clientY - dragging.current.y });
    }
  }
  function onTouchEnd(e: TouchEvent) {
    if (swipeStartX.current !== null && e.changedTouches.length === 1) {
      const dx = e.changedTouches[0].clientX - swipeStartX.current;
      if (Math.abs(dx) > SWIPE_THRESHOLD) go(dx > 0 ? -1 : 1);
    }
    pinch.current = null;
    dragging.current = null;
    swipeStartX.current = null;
  }

  const img = images[index];
  const busyGesture = dragging.current !== null || pinch.current !== null;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/90"
      style={{ touchAction: 'none' }}
      onClick={(e) => {
        // Also stop propagation so a backdrop click doesn't bubble up and close
        // the TaskDetailModal it's layered on top of.
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onWheel={onWheel}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white"
      >
        <X className="h-6 w-6" aria-hidden="true" />
      </button>

      {index > 0 ? (
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous photo"
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft className="h-8 w-8" aria-hidden="true" />
        </button>
      ) : null}
      {index < images.length - 1 ? (
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="Next photo"
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white"
        >
          <ChevronRight className="h-8 w-8" aria-hidden="true" />
        </button>
      ) : null}

      <img
        src={img.src}
        alt={img.alt ?? ''}
        draggable={false}
        onDoubleClick={toggleZoom}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
          transition: busyGesture ? 'none' : 'transform 150ms ease-out',
          cursor: scale > 1 ? 'grab' : 'zoom-in',
          touchAction: 'none',
        }}
        className="max-h-[90vh] max-w-[90vw] select-none object-contain"
      />

      {images.length > 1 ? (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-sm text-white/90">
          {index + 1} / {images.length}
        </div>
      ) : null}
    </div>
  );
}
