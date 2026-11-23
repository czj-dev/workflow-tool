import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { Preset } from "../../bindings/workflow-tool/internal/registry/models.js";
import { ActionIcon } from "./ActionIcon";
import { GAP_DEGREES, SELECTED_OFFSET, polar, type RingGeometry } from "./actionRingGeometry";

// 开环编排（点 1）：hub 先形变为正圆盘(~200ms)，扇形延迟 RING_OPEN_DELAY_MS 后
// 以「折扇展开」方式从收束位一起旋出：所有扇片初始折叠到 0 号扇片（正上方），
// 由每片的 --fan-from 角度变量驱动，像折扇打开而非逐片弹出。
export const RING_OPEN_DELAY_MS = 150;
// 摘瓣（点 2）：选中扇片沿自身角度飘出的距离(px)
const PETAL_FLY_DISTANCE = 56;

function sectorPath(inner: number, outer: number, start: number, end: number, center: number): string {
  const a = polar(outer, start);
  const b = polar(outer, end);
  const c = polar(inner, end);
  const d = polar(inner, start);
  const large = end - start > 180 ? 1 : 0;
  return `M ${center + a.x} ${center + a.y} A ${outer} ${outer} 0 ${large} 1 ${center + b.x} ${center + b.y} L ${center + c.x} ${center + c.y} A ${inner} ${inner} 0 ${large} 0 ${center + d.x} ${center + d.y} Z`;
}

interface ActionPresetRingProps {
  presets: Preset[];
  geometry: RingGeometry;
  selected: number;
  cursor?: { x: number; y: number };
  keyboard: boolean;
  label: string;
  /** hub 轴帽盖盘用的图标名(与卡片 hub 一致,视觉上重叠为同一圈盘) */
  hubIcon: string;
  /** 盖盘氛围色（CSS 变量串，取自卡根 --amb）：按下开环时盘面动态取卡面同源色，回落 primary */
  amb: string;
  /** 关环退场中：扇形组反向缩回环心（点 3） */
  exiting?: boolean;
  /** 摘瓣中：该 index 的扇片向外飘出、其余缩回，动画结束才执行事件（点 2） */
  plucking?: number;
  onChoose: (index: number) => void;
  onHover: (index: number) => void;
}

export function ActionPresetRing({
  presets, geometry, selected, cursor, keyboard, label, hubIcon, amb, exiting, plucking, onChoose, onHover,
}: ActionPresetRingProps) {
  const pad = SELECTED_OFFSET + 4;
  const mid = geometry.outer + pad;
  const size = mid * 2;
  const step = 360 / presets.length;
  const selectedPreset = selected >= 0 ? presets[selected] : undefined;
  const offset = selectedPreset ? polar(geometry.inner + (geometry.outer - geometry.inner) * 0.58, -90 + selected * step) : null;
  const anchor = cursor ?? (offset ? { x: geometry.x + offset.x, y: geometry.y + offset.y } : null);
  const placeLeft = anchor ? anchor.x > window.innerWidth / 2 : false;
  const placeAbove = anchor ? anchor.y > window.innerHeight / 2 : false;
  return createPortal(
    <>
    <svg
      data-testid="preset-ring"
      role="listbox"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="pointer-events-none fixed z-50 select-none overflow-visible drop-shadow-lg"
      style={{ left: geometry.x - mid, top: geometry.y - mid }}
    >
      {presets.map((preset, index) => {
        const angle = -90 + index * step;
        const gap = presets.length === 1 ? 0.2 : GAP_DEGREES;
        const start = angle - step / 2 + gap;
        const end = angle + step / 2 - gap;
        const position = polar(geometry.inner + (geometry.outer - geometry.inner) * 0.58, angle);
        const shift = polar(selected === index ? SELECTED_OFFSET : 0, angle);
        const active = selected === index;
        const fly = polar(PETAL_FLY_DISTANCE, angle);
        // 外层 g 承担生命周期动画（展开/收束/摘瓣），内层 g 只做选中位移，互不抢占 transform
        const sectorClass = exiting
          ? "preset-ring-fold"
          : plucking === undefined
            ? "preset-ring-spread"
            : index === plucking
              ? "preset-ring-fly"
              : "preset-ring-drop";
        return (
          <g
            key={preset.name}
            role="option"
            aria-label={preset.name}
            aria-selected={active}
            className={sectorClass}
            style={{
              transformOrigin: `${mid}px ${mid}px`,
              // 折扇:每片的收束起点角度(折叠到 0 号扇片)。延迟用 CSS 变量而非
              // animationDelay 内联——内联 delay 会覆盖 fold/fly/drop 类里“无延迟”的设定。
              "--spread-delay": `${RING_OPEN_DELAY_MS}ms`,
              "--fan-from": `${-(index * step)}deg`,
              "--fly-x": `${fly.x}px`,
              "--fly-y": `${fly.y}px`,
            } as CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerEnter={() => { if (keyboard) onHover(index); }}
            onClick={(event) => { event.stopPropagation(); if (keyboard) onChoose(index); }}
          >
            <g style={{ transform: `translate(${shift.x}px, ${shift.y}px)`, transition: "transform 140ms ease-out" }}>
              <title>{preset.name}</title>
              <path
                d={sectorPath(geometry.inner, geometry.outer, start, end, mid)}
                fill={active ? "var(--primary)" : "var(--card)"}
                stroke={active ? "var(--primary)" : "var(--border)"}
                strokeWidth="1.5"
                className="transition-colors duration-150 motion-reduce:transition-none"
              />
              <text
                x={mid + position.x}
                y={mid + position.y}
                fill={active ? "var(--primary-foreground)" : "var(--foreground)"}
                textAnchor="middle"
                dominantBaseline="central"
                className="pointer-events-none select-none fill-current font-mono text-[11px] font-semibold"
                style={{ fill: active ? "var(--primary-foreground)" : "var(--foreground)" }}
              >
                {preset.name.length > (geometry.outer < 110 ? 4 : 7)
                  ? `${preset.name.slice(0, geometry.outer < 110 ? 3 : 6)}…`
                  : preset.name}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
    {/* 盖盘:复制 hub 正圆盘置于扇叶之上(z 51 > svg 50)。展开/收束时扇叶从盘底滑入滑出，
        不叠在盘面上;稳态下与真实 hub 完全重合，视觉上就是同一只圆盘。
        盘面动态取卡面 --amb（开环即取色，设计稿 ring-cover 同源），未注入时回落 primary。 */}
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-[51] grid place-items-center rounded-[50%]
        bg-[var(--amb,var(--primary))]
        text-[color-mix(in_oklch,var(--amb,var(--primary))_25%,oklch(0.16_0.01_245))]
        shadow-[0_2px_12px_rgb(0_0_0/0.3)]"
      style={{
        "--amb": amb,
        left: geometry.x - geometry.inner,
        top: geometry.y - geometry.inner,
        width: geometry.inner * 2,
        height: geometry.inner * 2,
      } as CSSProperties}
    >
      {/* 图标视觉尺寸对齐真实 hub:size-5(20px)×scale(1.8)=36px=size-9 */}
      <ActionIcon name={hubIcon} className="size-9" />
    </div>
    {selectedPreset && anchor && !exiting && plucking === undefined && (
      <div
        data-testid="preset-selection-label"
        aria-hidden="true"
        className="pointer-events-auto fixed z-[60] select-none overflow-y-auto rounded-md border border-primary/50 bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground shadow-lg break-all"
        style={{
          left: placeLeft ? undefined : anchor.x + 14,
          right: placeLeft ? window.innerWidth - anchor.x + 14 : undefined,
          top: placeAbove ? undefined : anchor.y + 14,
          bottom: placeAbove ? window.innerHeight - anchor.y + 14 : undefined,
          maxWidth: Math.min(240, (placeLeft ? anchor.x : window.innerWidth - anchor.x) - 22),
          maxHeight: (placeAbove ? anchor.y : window.innerHeight - anchor.y) - 22,
        }}
      >
        {selectedPreset.name}
      </div>
    )}
    </>,
    document.body,
  );
}
