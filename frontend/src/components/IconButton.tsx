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
  disabled?: boolean;
  onClick?: () => void;
}

// 统一的图标按钮：视觉无文字，hover 显 tooltip。label 同时作 aria-label，
// 让屏幕阅读器与 testing-library（getByRole name）都能识别。base-ui Tooltip
// 顶层 TooltipProvider 已在 App 注入。
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "icon-sm",
  className,
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
            className={cn(className)}
          >
            <HugeiconsIcon icon={icon} strokeWidth={1.75} />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
