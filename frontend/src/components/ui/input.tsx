import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // 输入卡片：字段是一张小卡片（bg-card 浮面 + 轻浮起阴影），与 ActionCard 同一质感家族。
        // hover 琥珀边框 + 浮起加深（卡片同款），focus 边框点亮 + inset ring（无外光圈）。
        // 值用 mono 读数（数据语义），全局配置 / logcat 过滤等输入场景同样适用。
        "h-10 w-full min-w-0 rounded-lg border border-border bg-card px-3 py-1 font-mono text-sm tabular-nums shadow-[var(--card-sh)] transition-[color,border-color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/75 hover:border-primary/50 hover:shadow-[var(--card-sh-hover)] focus-visible:border-primary/60 focus-visible:shadow-[inset_0_0_0_1px] focus-visible:shadow-primary/28 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
