// 两行分区头（config-pages 共享零件）：新建分组对话框里的预览与侧栏分区画的是同一个头。
// 源自原型 config-pages.prototype/section.tsx（方案 A 定稿）。结构与 AppSidebar 的
// SectionEntry 同构（色块 / 组名 / 副行 + 计数 / ›）。头本身是 div.side-head（吃 hover 染色），
// 主按钮占满左侧，右侧留给附加动作（改色 / 删除分组）。
// 色块盘面 .side-hub-mini 与字形色 --ink 都来自所在的 .side-sec[data-amb]，本组件不认识具体颜色。
import type { ComponentProps, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];

export function SectionHead({
  icon,
  name,
  sub,
  count,
  collapsed = false,
  onToggle,
  action,
}: {
  icon: Icon;
  name: string;
  sub: string;
  count: number;
  collapsed?: boolean;
  /** 省略 = 纯展示（对话框预览）：不画成按钮，不进 Tab 序 */
  onToggle?: () => void;
  action?: ReactNode;
}) {
  const body = (
    <>
      <span
        className="side-hub-mini grid size-5 shrink-0 place-items-center rounded-[27.5%]"
        aria-hidden="true"
      >
        <HugeiconsIcon icon={icon} strokeWidth={1.75} className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-[18px] font-semibold text-foreground">
          {name}
        </span>
        <span className="side-sub flex min-w-0 items-center gap-1 text-xs leading-[18px]">
          <span className="truncate font-medium">{sub}</span>
          <span className="side-count shrink-0 font-mono">·{count}</span>
        </span>
      </span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        strokeWidth={2.25}
        aria-hidden="true"
        className={cn("side-chev size-4.5 shrink-0 text-foreground", !collapsed && "rotate-90")}
      />
    </>
  );

  return (
    <div className="side-head group/head mb-2 flex h-9 items-center gap-1 rounded-md pl-1.5 pr-1">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch">{body}</div>
      )}
      {action}
    </div>
  );
}
