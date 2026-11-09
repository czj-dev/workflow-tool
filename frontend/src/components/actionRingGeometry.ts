export interface RingGeometry {
  x: number;
  y: number;
  inner: number;
  outer: number;
  count: number;
}

export const GAP_DEGREES = 1;
export const SELECTED_OFFSET = 6;

export function ringGeometry(rect: DOMRect, count: number): RingGeometry {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const outer = Math.max(0, Math.min(178, x - 8, window.innerWidth - x - 8, y - 8, window.innerHeight - y - 8));
  return { x, y, outer, inner: Math.min(72, outer * 0.42), count };
}

export function polar(radius: number, angle: number) {
  const rad = angle * Math.PI / 180;
  return { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
}

export function ringHit(geometry: RingGeometry, x: number, y: number, selected = -1): number {
  if (!geometry.count) return -1;
  const step = 360 / geometry.count;
  const initial = (Math.atan2(y - geometry.y, x - geometry.x) * 180 / Math.PI + 90 + 360) % 360;
  const index = Math.round(initial / step) % geometry.count;
  const shift = polar(index === selected ? SELECTED_OFFSET : 0, -90 + index * step);
  const dx = x - geometry.x - shift.x;
  const dy = y - geometry.y - shift.y;
  const radius = Math.hypot(dx, dy);
  if (radius < geometry.inner || radius > geometry.outer) return -1;
  if (geometry.count === 1) return 0;
  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
  const delta = Math.abs((angle - index * step + 540) % 360 - 180);
  return delta < step / 2 - GAP_DEGREES ? index : -1;
}
