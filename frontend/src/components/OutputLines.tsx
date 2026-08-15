import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// 共享的输出行渲染：action 的 OutputConsole 与 workflow step 卡片都用它，
// 保证 stderr 着色 / 退出码行着色两边一致（progress 行的 \r 覆盖已在 foldOutputLine 处理）。
interface OutputLinesProps {
  lines: string[];
  // 非空时把末行按退出码着色（成功→success，失败→destructive）
  exitCode?: number;
  className?: string;
}

export function OutputLines({ lines, exitCode, className }: OutputLinesProps) {
  const { t } = useTranslation();
  const stderrPrefix = t("output.stderrPrefix");
  const lastIdx = lines.length - 1;

  return (
    <>
      {lines.map((line, i) => {
        let cls = "text-foreground";
        if (exitCode !== undefined && i === lastIdx) {
          cls = exitCode === 0 ? "text-success" : "text-destructive font-medium";
        } else if (stderrPrefix && line.startsWith(stderrPrefix)) {
          cls = "text-destructive/80";
        }
        return (
          <span key={i} className={cn("block", cls, className)}>
            {line || " "}
          </span>
        );
      })}
    </>
  );
}
