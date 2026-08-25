import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Clock01Icon, CommandIcon, FlashIcon } from "@hugeicons/core-free-icons";
import type { WorkflowStepInfo } from "../../bindings/workflow-tool/internal/api/models.js";
import { STEP_ICON, WorkflowStepsOverview } from "./WorkflowStepsOverview";

// 后端 WorkflowStepInfo.Kind 的全部取值（internal/api/workflows.go:18）。
// 少一个键就落到 ?? FlashIcon 兜底、退化成 action 的闪电图标——
// 正是 shell→run 改名踩到的回归。
const BACKEND_KINDS = ["action", "sleep", "run"] as const;

describe("WorkflowStepsOverview", () => {
  it("图标表覆盖后端全部 step kind", () => {
    for (const kind of BACKEND_KINDS) {
      expect(STEP_ICON[kind], `kind=${kind} 缺图标`).toBeDefined();
    }
  });

  it("每个 kind 映射到各自的图标（run 不是 action 的闪电）", () => {
    expect(STEP_ICON.run).toBe(CommandIcon);
    expect(STEP_ICON.run).not.toBe(FlashIcon);
    expect(STEP_ICON.action).toBe(FlashIcon);
    expect(STEP_ICON.sleep).toBe(Clock01Icon);
  });

  it("渲染 run 步的 label 与 kind 文案", () => {
    const steps: WorkflowStepInfo[] = [{ kind: "run", label: "echo hi", name: "" }];
    render(<WorkflowStepsOverview steps={steps} />);
    expect(screen.getByText("echo hi")).toBeInTheDocument();
    expect(screen.getByText("run")).toBeInTheDocument();
  });
});
