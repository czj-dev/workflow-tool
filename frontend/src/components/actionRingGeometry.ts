export interface RingGeometry {
  x: number;
  y: number;
  inner: number;
  outer: number;
  count: number;
}

export const GAP_DEGREES = 1;
export const SELECTED_OFFSET = 6;

// 内孔半径 = 卡高一半（宽卡 72px 高 → inner=36，扇形内沿贴卡上下沿，
// hub 正圆盘放大后正好填满内孔成为环心）。卡高异常时钳制在 [28, 64] 兜底。
const MIN_INNER = 28;
const MAX_INNER = 64;
// 环离视口边的最小留白 —— 按视口（而非内容区）钳制，环允许压在左侧栏上借空间。
const RING_MARGIN = 10;
// 外内半径差低于此值说明空间不足，不开环。
export const MIN_RING_BAND = 30;

// 锚点 = hub（卡片图标容器）中心。极坐标数学与锚点位置无关，命中共用 ringHit。
export function ringGeometry(hubRect: DOMRect, count: number, cardHeight: number): RingGeometry {
  const x = hubRect.left + hubRect.width / 2;
  const y = hubRect.top + hubRect.height / 2;
  const inner = Math.max(MIN_INNER, Math.min(MAX_INNER, cardHeight / 2));
  const outer = Math.max(0, Math.min(
    178,
    inner + 78,
    x - RING_MARGIN,
    window.innerWidth - x - RING_MARGIN,
    y - RING_MARGIN,
    window.innerHeight - y - RING_MARGIN,
  ));
  return { x, y, inner, outer, count };
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
