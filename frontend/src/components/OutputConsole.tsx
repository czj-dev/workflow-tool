import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useActionRunner } from "../hooks/useActionRunner";

// 滚动终端区：运行中顶部一条横向流光（数据流入感），逐行渲染，
// stderr 走 destructive，退出码行（末行）按 exitCode 着色（成功/失败）。
// 新行自动滚到底。
export function OutputConsole() {
  const { t } = useTranslation();
  const { lines, exitInfo, status } = useActionRunner();
  const bottomRef = useRef<HTMLDivElement>(null);
  const stderrPrefix = t("output.stderrPrefix");
  const lastIdx = lines.length - 1;

  // 新行自动滚到底（scrollIntoView?. 防御 jsdom 无此方法）
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "auto" });
  }, [lines]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {status === "running" && (
        <div className="spine-flow-h mx-4 mt-1 h-0.5 shrink-0 rounded-full" />
      )}
      <ScrollArea className="min-h-0 flex-1">
        <pre className="p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
          {lines.map((line, i) => {
            let cls = "text-foreground";
            if (exitInfo && i === lastIdx) {
              // 末行是退出码行：成功→success，失败→destructive
              cls =
                exitInfo.exitCode === 0
                  ? "text-success"
                  : "text-destructive font-medium";
            } else if (stderrPrefix && line.startsWith(stderrPrefix)) {
              cls = "text-destructive/80";
            }
            return (
              <span key={i} className={`block ${cls}`}>
                {line || " "}
              </span>
            );
          })}
          <div ref={bottomRef} />
        </pre>
      </ScrollArea>
    </div>
  );
}
