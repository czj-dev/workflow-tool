import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // 输入卡片语言同 Input：bg-card 浮面 + 浮起阴影，hover 琥珀边框，focus inset ring；mono 读数
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-sm tabular-nums shadow-[var(--card-sh)] transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground/75 hover:border-primary/50 hover:shadow-[var(--card-sh-hover)] focus-visible:border-primary/60 focus-visible:shadow-[inset_0_0_0_1px] focus-visible:shadow-primary/28 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
