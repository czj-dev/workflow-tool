import type { ReactNode } from "react";
import { FOOTPRINT_SEGMENTS } from "../hooks/useActionUsage";

/* eslint-disable react-refresh/only-export-components -- 双态卡零件库：组件与 amb/narrative 工具函数同文件共享，非 fast-refresh 边界文件 */

// Grid 卡片共享零件：Actions / Workflows / Llm 三个 view 复用，避免样式复制漂移。
// 双态卡骨架（ADR-0001）与氛围色（ADR-0003）在此下沉；token 表见 .design/workflow-card-mockup.html。

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
// compact：约一半尺寸、无计数读数、靠左——键面（130px StreamDeck）等小卡用。
export function StatusRail({
  level, score, compact,
}: { level: number; score: number; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex h-2 w-full items-center gap-1.5">
        <span
          className="size-1 shrink-0 rounded-full bg-foreground/25 transition-colors
            group-hover:bg-primary group-focus-visible:bg-primary
            group-data-[running]:bg-primary"
        />
        <div className="flex items-center gap-[2px]">
          {Array.from({ length: FOOTPRINT_SEGMENTS }, (_, i) => (
            <span
              key={i}
              className={`h-[3px] w-1.5 rounded-[1px] ${i < level ? "bg-primary/65" : "bg-foreground/12"}`}
            />
          ))}
        </div>
      </div>
    );
  }
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

// —— 氛围色（ADR-0003）——

// 四色按「分组显示序」循环取色（设计稿 token 表：图标色缺省时按序循环）——
// 相邻组必然异色（ADB 与 DEMO 不再撞色），组内同色。传入该组在排序后的位次。
const AMB_CYCLE = ["var(--amb-amber)", "var(--amb-green)", "var(--amb-blue)", "var(--amb-violet)"] as const;
export function ambFor(index: number): string {
  const n = AMB_CYCLE.length;
  return AMB_CYCLE[((index % n) + n) % n];
}

// 预设点阵：紧凑态 hub 旁的「有预设、可长按」暗示（结构即提示）。
export function PresetDots({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden="true" className="flex flex-none items-center gap-[3px] self-start pt-2.5">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className="size-[3px] rounded-full bg-[color-mix(in_oklch,var(--amb)_70%,transparent)]" />
      ))}
    </span>
  );
}

// ❝ 叙述区：展开态的弹性文本区（Workflow=描述 / LLM=最近会话摘要；运行输出流是演进位）。
export function NarrativeZone({ stamp, children }: { stamp?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 gap-2.5 py-0.5">
      <span
        aria-hidden="true"
        className="shrink-0 select-none pt-px font-serif text-[26px] leading-none
          text-[color-mix(in_oklch,var(--amb)_55%,transparent)]"
      >
        ❝
      </span>
      <p className="line-clamp-4 max-w-64ch text-[13px] leading-[1.75] text-foreground/85">
        {stamp && (
          <span className="mr-2 font-mono text-[10.5px] tracking-[0.04em] text-[color-mix(in_oklch,var(--amb)_80%,var(--muted-foreground))]">
            {stamp}
          </span>
        )}
        {children}
      </p>
    </div>
  );
}

// 展开态预设 chips：预设双路径的「浏览」侧（沿用 LlmChatView composer 虚线 chip 语言，amb 化）。
export function PresetChips({
  presets, onChoose,
}: {
  presets: readonly { name: string; description?: string }[];
  onChoose: (name: string) => void;
}) {
  return (
    <>
      {presets.map((preset) => (
        <button
          key={preset.name}
          type="button"
          title={preset.description || preset.name}
          onClick={(e) => { e.stopPropagation(); onChoose(preset.name); }}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-dashed
            border-[color-mix(in_oklch,var(--amb)_40%,var(--border))] bg-muted/55 px-2.5
            font-mono text-[11px] tracking-[0.02em] text-muted-foreground transition-colors
            hover:border-solid hover:border-[color-mix(in_oklch,var(--amb)_65%,transparent)]
            hover:bg-[color-mix(in_oklch,var(--amb)_10%,transparent)] hover:text-foreground
            focus-visible:outline-none focus-visible:border-solid"
        >
          <span aria-hidden="true" className="text-[9px] text-[var(--amb)]">▸</span>
          {preset.name}
        </button>
      ))}
    </>
  );
}

// 功能行次要钮（编辑表单 / 编辑配置）：ghost 形制，hover 拾 amb 边光。
export function GhostBtn({
  label, onClick, icon,
}: { label: string; onClick: () => void; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border
        border-border bg-card/55 px-3 font-mono text-[11.5px] tracking-[0.04em]
        text-muted-foreground transition-colors
        hover:border-[color-mix(in_oklch,var(--amb)_50%,transparent)] hover:text-foreground
        focus-visible:outline-none focus-visible:border-[color-mix(in_oklch,var(--amb)_50%,transparent)]"
    >
      {icon}
      {label}
    </button>
  );
}

// 单一主控：展开态功能行右下唯一主钮（RUN / 对话）。运行中转为读数态（不可再点）。
export function RunPill({
  label, runningLabel, running, onClick, live = true,
}: {
  label: string;
  runningLabel?: string;
  running?: boolean;
  onClick: () => void;
  live?: boolean;
}) {
  if (running) {
    return (
      <span className="ml-auto inline-flex h-9 items-center gap-2 rounded-full
        bg-[color-mix(in_oklch,var(--primary)_15%,transparent)] px-4.5
        font-mono text-[12px] font-bold tracking-[0.18em] text-primary">
        {live && <span className="size-1.5 rounded-full bg-primary live-pulse" />}
        {runningLabel ?? label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="ml-auto inline-flex h-9 cursor-pointer items-center gap-2 rounded-full
        border-none bg-primary px-4.5 font-mono text-[12px] font-bold
        tracking-[0.14em] text-primary-foreground transition-[filter,transform] duration-100
        hover:brightness-108 focus-visible:outline-none active:scale-0.96 motion-reduce:transition-none"
    >
      <span aria-hidden="true" className="text-[10px]">▶</span>
      {label}
    </button>
  );
}

// 紧凑态 hover 显形动作（键盘 :focus-within 同步显形）：▸ RUN / ▸ 对话 等快照式入口。
export function QuickHint({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="cursor-pointer font-mono text-[11px] tracking-[0.14em] text-primary
        opacity-0 transition-opacity duration-150
        group-hover:opacity-100 group-focus-within:opacity-100"
    >
      ▸ {label}
    </button>
  );
}

// 运行中卡片顶沿流光：复用 index.css 的 .spine-flow-h。className 可覆盖圆角（如键面 rounded-t-xl）
export function RunningFlow({ className = "" }: { className?: string }) {
  return (
    <span
      className={`spine-flow-h pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-t-lg ${className}`}
    />
  );
}

// ❝区时间戳：今日 HH:mm，今年 MM-DD HH:mm，更早补年份。纯数字格式，无需翻译。
export function narrativeStamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}
