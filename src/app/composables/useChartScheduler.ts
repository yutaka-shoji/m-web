/**
 * One requestAnimationFrame loop for every chart: a chart redraws at most once per frame,
 * only while visible (IntersectionObserver, page not hidden) and only when its data signature
 * changed. Redraws are spread over frames with a time budget, so many charts updating at once
 * never block input. Long windows can ask for a minimum interval between redraws.
 * Data collection never depends on this loop (rAF stops in background tabs).
 */
export interface Drawable {
  visible: boolean;
  /** Current data signature; the chart is dirty when it differs from the last drawn one. */
  signature(): string;
  draw(): void;
  minIntervalMs(): number;
  lastDraw: number;
  drawnSig: string;
}

const FRAME_BUDGET_MS = 8;
const drawables: Drawable[] = [];
let raf = 0;
let cursor = 0;

function frame(): void {
  raf = 0;
  if (typeof document !== 'undefined' && !document.hidden && drawables.length) {
    const start = performance.now();
    // round-robin so a chart that missed the budget goes first next frame
    for (let n = 0; n < drawables.length; n++) {
      const d = drawables[(cursor + n) % drawables.length]!;
      if (!d.visible || start - d.lastDraw < d.minIntervalMs()) continue;
      const sig = d.signature();
      if (sig === d.drawnSig) continue;
      d.draw();
      d.drawnSig = sig;
      d.lastDraw = performance.now();
      if (performance.now() - start > FRAME_BUDGET_MS) {
        cursor = (cursor + n + 1) % drawables.length;
        break;
      }
    }
  }
  if (drawables.length > 0) raf = requestAnimationFrame(frame);
}

export function registerDrawable(d: Drawable): () => void {
  drawables.push(d);
  if (!raf) raf = requestAnimationFrame(frame);
  return () => {
    const i = drawables.indexOf(d);
    if (i >= 0) drawables.splice(i, 1);
    if (drawables.length === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
