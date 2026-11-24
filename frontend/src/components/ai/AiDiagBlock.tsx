import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AiDiagLine } from "../../types/events";

// AI 运行的诊断块：失败原因 + runner 的 stdout / stderr 行。会话页（实时）与运行详情
// （回放）共用——同一个 AI 运行在这两处看到的诊断是同一副样子。
export function AiDiagBlock({
  failed,
  error,
  lines,
  className,
}: {
  // failed：这一轮以失败收场（标题换成「运行失败」并先列出原因）
  failed: boolean;
  error?: string;
  lines: AiDiagLine[];
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 font-mono text-[11px] leading-relaxed", className)}>
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-destructive">
        <span className="size-1.5 rounded-full bg-destructive" />
        {failed ? t("aiChat.runFailed") : t("aiChat.diagnostics")}
      </div>
      {failed && error && <div className="mb-1 whitespace-pre-wrap break-all text-destructive">{error}</div>}
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all text-muted-foreground">
          {line.stream === "stderr" ? t("output.stderrPrefix") : ""}
          {line.text}
        </div>
      ))}
    </div>
  );
}
