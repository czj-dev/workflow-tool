import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface IconButtonProps {
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  /** tooltip 文案 + aria-label（同时决定无障碍名与测试断言的 accessible name） */
  label: string;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
  /** 透传给内部 HugeiconsIcon（如 saving 态的 animate-spin） */
  iconClassName?: string;
  /** 右上角数字角标（如 LLM 历史 N 条）；0/undefined 不渲染。需可读时由调用方并入 label（如「历史 · 3」） */
  badge?: number;
  /** 右上角 live-pulse 脉冲点（dirty/待保存提示） */
  dot?: boolean;
  disabled?: boolean;
  onClick?: (e?: React.MouseEvent) => void;
}

// 统一的图标按钮：视觉无文字，hover 显 tooltip。label 同时作 aria-label，
// 让屏幕阅读器与 testing-library（getByRole name）都能识别。base-ui Tooltip
// 顶层 TooltipProvider 已在 App 注入。
// badge/dot 绝对定位在按钮右上角（按钮恒 relative），pointer-events-none 不挡点击。
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "icon-sm",
  className,
  iconClassName,
  badge,
  dot,
  disabled,
  onClick,
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            size={size}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={cn("relative", className)}
          >
            <HugeiconsIcon icon={icon} strokeWidth={1.75} className={iconClassName} />
            {badge !== undefined && badge > 0 && (
              <span className="pointer-events-none absolute -right-1.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-primary px-0.5 font-mono text-[9px] leading-3.5 text-primary-foreground tabular-nums">
                {badge}
              </span>
            )}
            {dot && (
              <span className="live-pulse pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
            )}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
