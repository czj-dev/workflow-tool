import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useActionRunner } from "../hooks/useActionRunner";

// 滚动终端区：渲染输出行，新行自动滚到底
export function OutputConsole() {
  const { lines } = useActionRunner();
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新行自动滚到底（scrollIntoView?. 防御 jsdom 无此方法）
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "auto" });
  }, [lines]);

  return (
    <ScrollArea className="flex-1 bg-zinc-950">
      <pre className="p-4 font-mono text-[13px] leading-relaxed text-zinc-100 whitespace-pre-wrap">
        {lines.join("\n")}
        <div ref={bottomRef} />
      </pre>
    </ScrollArea>
  );
}
