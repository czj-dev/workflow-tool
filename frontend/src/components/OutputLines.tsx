import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { OutputLineItem } from "../types/events";
import { ResolveTreeClick } from "../../bindings/workflow-tool/internal/api/service.js";
import { useActionRunner } from "../hooks/useActionRunner";
import { TreeBlock } from "./TreeBlock";

// 共享的输出行渲染：action 的 OutputConsole 与 workflow step 卡片都用它，
// 保证 stderr 着色 / 退出码行着色两边一致（progress 行的 \r 覆盖已在 foldOutputLine 处理）。
// 行项是联合类型：文本/进度行照旧渲染，树帧行原地渲染 TreeBlock（第三种内容形态）。
interface OutputLinesProps {
  lines: OutputLineItem[];
  // 非空时把末行按退出码着色（成功→success，失败→destructive）
  exitCode?: number;
  className?: string;
}

export function OutputLines({ lines, exitCode, className }: OutputLinesProps) {
  const { t } = useTranslation();
  const { actions, runAction, isRunning } = useActionRunner();
  const stderrPrefix = t("output.stderrPrefix");
  const lastIdx = lines.length - 1;

  return (
    <>
      {lines.map((item, i) => {
        if (item.kind === "tree") {
          const source = item.frame.source;
          const click = actions.find((action) => action.id === source?.actionId)?.hmi?.tree?.click;
          return <TreeBlock key={`tree-${item.id}`} frame={item.frame} onLeafClick={click && source ? async (node) => {
            const result = await ResolveTreeClick(source.actionId, node as unknown as Record<string, unknown>, source.params);
            if (isRunning(result.action)) throw new Error(t("tree.actionRunning"));
            await runAction(result.action, result.params, false, Object.keys(result.params));
          } : undefined} />;
        }
        let cls = "text-foreground";
        if (exitCode !== undefined && i === lastIdx) {
          cls = exitCode === 0 ? "text-success" : "text-destructive font-medium";
        } else if (stderrPrefix && item.text.startsWith(stderrPrefix)) {
          cls = "text-destructive/80";
        }
        return (
          <span key={i} className={cn("block", cls, className)}>
            {item.text || " "}
          </span>
        );
      })}
    </>
  );
}
