import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CommandIcon,
  Clock01Icon,
  FlashIcon,
} from "@hugeicons/core-free-icons";
import type { WorkflowStepInfo } from "../../bindings/workflow-tool/internal/api/models.js";

// 键必须与后端 WorkflowStepInfo.Kind 的取值一一对应（internal/api/workflows.go:18）：
// 缺键会落到下方 ?? FlashIcon 兜底，内联步图标退化成 action 的闪电。
// 导出的是常量而非组件，故触发 react-refresh 规则；导出目的是让单测能锁住
// 「图标表覆盖后端全部 kind」这一契约。本文件是纯展示组件，HMR 状态保留的损失可忽略。
// eslint-disable-next-line react-refresh/only-export-components
export const STEP_ICON = {
  action: FlashIcon,
  sleep: Clock01Icon,
  run: CommandIcon,
} as const;

// 配置态的静态管线预览：每行一个步骤（节点 + 连线 + 序号 + 图标 + 名称 + kind），
// 与运行态 WorkflowView 的 Pipeline Spine 共用同一套视觉语言（此处全部默认态/灰）。
export function WorkflowStepsOverview({ steps }: { steps: WorkflowStepInfo[] }) {
  const { t } = useTranslation();
  if (!steps || steps.length === 0) return null;

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
        {t("workflow.steps")}
      </div>
      <div className="flex flex-col">
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          const name =
            s.kind === "sleep"
              ? t("workflow.stepSleep", {
                  seconds: s.label.replace(/s$/, ""),
                })
              : s.label;
          return (
            <div key={i} className="flex items-start gap-2.5">
              {/* 左列：节点 + 连线（self-stretch 拉满，pb 撑大让连线贯穿）。
                  节点用 pending 空心样式，与运行态 Pipeline Spine 同一语言 */}
              <div className="flex flex-col items-center self-stretch">
                <span className="mt-1 size-2 rounded-full border-2 border-muted-foreground/40" />
                {!last && <span className="my-1 w-px flex-1 bg-border" />}
              </div>
              {/* 右列：序号 + 图标 + 名称 + kind */}
              <div className="flex flex-1 items-center gap-2 pb-3">
                <span className="font-mono text-[10px] text-muted-foreground/50">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <HugeiconsIcon
                  icon={STEP_ICON[s.kind as keyof typeof STEP_ICON] ?? FlashIcon}
                  strokeWidth={1.75}
                  className="size-3.5 text-muted-foreground"
                />
                <span className="flex-1 truncate text-sm">{name}</span>
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/45">
                  {s.kind}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
