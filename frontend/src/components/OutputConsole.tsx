import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputLines } from "./OutputLines";

// 滚动终端区：运行中顶部一条横向流光（数据流入感），逐行渲染，
// stderr 走 destructive，退出码行（末行）按 exitCode 着色（成功/失败）。
// 新行自动滚到底。无输出且非运行中 → 待命空态（tick 分隔线 + mono 读数，呼应 Grid）。
export function OutputConsole() {
  const { t } = useTranslation();
  const { lines, exitInfo, status } = useActionRunner();
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新行自动滚到底（scrollIntoView?. 防御 jsdom 无此方法）
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "auto" });
  }, [lines]);

  if (lines.length === 0 && status !== "running") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background pb-10">
        <span className="tick-ruler w-44" aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          {t("main.standby")}
        </p>
        <p className="text-xs text-muted-foreground/80">{t("main.standbyHint")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {status === "running" && (
        <div className="spine-flow-h mx-4 mt-1 h-0.5 shrink-0 rounded-full" />
      )}
      <ScrollArea className="min-h-0 flex-1">
        <pre className="p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
          <OutputLines lines={lines} exitCode={exitInfo?.exitCode} />
          <div ref={bottomRef} />
        </pre>
      </ScrollArea>
    </div>
  );
}
