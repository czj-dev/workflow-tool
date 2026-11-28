// 五色色卡（规格 G 通用原子）：从氛围色五色板里选色的单选控件。
// props 只有「当前色 / 变更回调 / 可选的未设置档」——不耦合分组或片段的数据形状，
// 需求方已明确色卡以后可能应用到全局卡片（双态卡）的选色，届时直接复用。
// 可访问性（规格无障碍节）：role=radiogroup + 漫游 Tab（只有选中项在 Tab 序里），
// ← → ↑ ↓ 即选中新色并把焦点带过去；可读颜色名走 i18n shared.* 命名空间。
// 选中 = 实色盘面上的对勾 + 细描边，不加文字徽标。
import { type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { AMB_COLORS, SWATCH_BG, type AmbColor, type AmbColorValue } from "./colors";

/** 可读颜色名的 i18n key（shared.* 两页共用小命名空间）。 */
const COLOR_NAME_KEY: Record<AmbColor, string> = {
  amber: "shared.colorAmber",
  green: "shared.colorGreen",
  cyan: "shared.colorCyan",
  blue: "shared.colorBlue",
  violet: "shared.colorViolet",
};

export function Swatches({
  value,
  onChange,
  label,
  unsetLabel,
  className,
}: {
  /** 当前色；null = 未设置（只有启用未设置档时才会是选中态） */
  value: AmbColorValue;
  onChange: (color: AmbColorValue) => void;
  /** 无障碍名（radiogroup 的 aria-label，调用方顺带当可见标题用） */
  label: string;
  /** 传入即启用「未设置」档：追加一个 null 值的单选项（如片段未选色跟随分区色） */
  unsetLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const items: { key: AmbColorValue; name: string; bg?: string }[] = [
    ...AMB_COLORS.map((k) => ({ key: k, name: t(COLOR_NAME_KEY[k]), bg: SWATCH_BG[k] })),
    // items 已标注 key: AmbColorValue，这里 null 由上下文类型收窄（as const 不支持 null）
    ...(unsetLabel ? [{ key: null, name: unsetLabel }] : []),
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    // 步进基准 = 焦点所在的 radio（漫游 Tab 语义：方向键相对焦点移动）；
    // 事件不是从 radio 起的（理论路径）才回落到当前值
    const radios = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    const from = radios.indexOf(e.target as HTMLButtonElement);
    const idx = from >= 0 ? from : items.findIndex((it) => it.key === value);
    const next = (idx + step + items.length) % items.length;
    onChange(items[next].key);
    // 焦点跟着选中项走：漫游 Tab 下旧按钮已退出 Tab 序，得手动把焦点交给新的那一个
    radios[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex items-center gap-1.5", className)}
    >
      {items.map((it) => {
        const on = it.key === value;
        return (
          <button
            key={String(it.key)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={it.name}
            title={it.name}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.key)}
            className={cn(
              "grid size-7 shrink-0 cursor-pointer place-items-center rounded-[27.5%] outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-ring/60 aria-checked:ring-2 aria-checked:ring-foreground/30 aria-checked:ring-offset-2 aria-checked:ring-offset-popover",
              it.bg ?? "border border-dashed border-muted-foreground/45 bg-muted/50",
            )}
          >
            {on && (
              <HugeiconsIcon
                icon={Tick02Icon}
                strokeWidth={2.25}
                className={cn("size-4", it.bg ? "text-background" : "text-foreground")}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
