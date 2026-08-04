import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CommandIcon,
  Clock01Icon,
  FlashIcon,
} from "@hugeicons/core-free-icons";
import type { WorkflowStepInfo } from "../../bindings/workflow-tool/internal/api/models.js";

const STEP_ICON = {
  action: FlashIcon,
  sleep: Clock01Icon,
  shell: CommandIcon,
} as const;

// WorkflowStepsOverview 在 workflow 参数表单上方展示步骤链概览。
export function WorkflowStepsOverview({ steps }: { steps: WorkflowStepInfo[] }) {
  const { t } = useTranslation();
  if (!steps || steps.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-3 py-2">
      {steps.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-xs text-muted-foreground">→</span>}
          <Badge variant="secondary" className="gap-1 text-xs font-normal">
            <HugeiconsIcon
              icon={STEP_ICON[s.kind as keyof typeof STEP_ICON] ?? FlashIcon}
              strokeWidth={1.75}
              className="size-3"
            />
            {s.kind === "action"
              ? s.label
              : s.kind === "sleep"
                ? t("workflow.stepSleep", { seconds: s.label.replace(/s$/, "") })
                : s.label}
          </Badge>
        </span>
      ))}
    </div>
  );
}
