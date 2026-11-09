import { createPortal } from "react-dom";
import type { Preset } from "../../bindings/workflow-tool/internal/registry/models.js";
import { GAP_DEGREES, SELECTED_OFFSET, polar, type RingGeometry } from "./actionRingGeometry";

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
  onChoose: (index: number) => void;
  onHover: (index: number) => void;
}

export function ActionPresetRing({ presets, geometry, selected, cursor, keyboard, label, onChoose, onHover }: ActionPresetRingProps) {
  const pad = SELECTED_OFFSET + 4;
  const mid = geometry.outer + pad;
  const size = mid * 2;
  const step = 360 / presets.length;
  const selectedPreset = presets[selected];
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
        return (
          <g
            key={preset.name}
            role="option"
            aria-label={preset.name}
            aria-selected={active}
            className={keyboard ? "pointer-events-auto cursor-pointer" : ""}
            style={{ transform: `translate(${shift.x}px, ${shift.y}px)`, transition: "transform 140ms ease-out" }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerEnter={() => { if (keyboard) onHover(index); }}
            onClick={(event) => { event.stopPropagation(); if (keyboard) onChoose(index); }}
          >
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
        );
      })}
    </svg>
    {selectedPreset && anchor && (
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
