import { FOOTPRINT_SEGMENTS } from "../hooks/useActionUsage";

// Grid 卡片共享零件：Actions / Workflows 两个 view 复用，避免样式复制漂移。

// 分组头刻度尺：tick 数 = 该组条目数，lit 段 = 已用过的条目数（结构即信息）。
export function TickRuler({ total, lit }: { total: number; lit: number }) {
  return (
    <span className="tick-ruler" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} {...(i < lit ? { "data-lit": "" } : {})} />
      ))}
    </span>
  );
}

// 卡片顶部仪表条：状态点 + 使用足迹 + 访问计数。三件散装信息合成一条可读 rail。
export function StatusRail({ level, score }: { level: number; score: number }) {
  return (
    <div className="flex h-3 items-center gap-2">
      <span
        className="size-[7px] shrink-0 rounded-full bg-foreground/25 transition-colors
          group-hover:bg-primary group-focus-visible:bg-primary
          group-data-[running]:bg-primary"
      />
      <div className="flex items-center gap-[3px]">
        {Array.from({ length: FOOTPRINT_SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={`h-0.5 w-2 rounded-sm ${i < level ? "bg-primary/65" : "bg-foreground/12"}`}
          />
        ))}
      </div>
      <span className="ml-auto font-mono text-[10.5px] tracking-[0.06em] tabular-nums text-muted-foreground">
        ·{Math.round(score)}
      </span>
    </div>
  );
}

// 参数摘要：列出 param id，不点开就知道要什么输入。超出 MAX 折叠为 +N。
const PARAM_SUMMARY_MAX = 4;

export function ParamSummary({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, PARAM_SUMMARY_MAX);
  const rest = ids.length - shown.length;
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/90">
      {shown.map((id) => (
        <span key={id} className="relative pl-[11px] before:absolute before:left-0 before:top-1/2
          before:size-[5px] before:-translate-y-1/2 before:rounded-[1px] before:bg-foreground/30">
          {id}
        </span>
      ))}
      {rest > 0 && <span className="tabular-nums">+{rest}</span>}
    </div>
  );
}

// 运行中卡片顶沿流光：复用 index.css 的 .spine-flow-h
export function RunningFlow() {
  return (
    <span className="spine-flow-h pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-t-lg" />
  );
}
