import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiBrain01Icon, Clock01Icon, CommandIcon, FlashIcon } from "@hugeicons/core-free-icons";
import type { WorkflowStepInfo } from "../../bindings/workflow-tool/internal/api/models.js";
import { STEP_ICON, WorkflowStepsOverview } from "./WorkflowStepsOverview";

// 后端 WorkflowStepInfo.Kind 的全部取值（internal/api/workflows.go:18），前端硬编码的第二份清单。
// 本用例锁的是前端表自身的自洽性：四个键都在、四个图标不写混——少一个键就落到
// ?? FlashIcon 兜底、退化成 action 的闪电图标。
// 注意：后端把 Kind 取值改名（如 shell→run 那次）本用例抓不到——此处也要同步改名才会变红；
// 后端改名的防线是 internal/api/workflows.go:18 指向本文件 STEP_ICON 的交叉引用注释。
const BACKEND_KINDS = ["action", "sleep", "run", "ai"] as const;

describe("WorkflowStepsOverview", () => {
  it("图标表覆盖后端全部 step kind", () => {
    for (const kind of BACKEND_KINDS) {
      expect(STEP_ICON[kind], `kind=${kind} 缺图标`).toBeDefined();
    }
  });

  it("每个 kind 映射到各自的图标（run / ai 不是 action 的闪电）", () => {
    expect(STEP_ICON.run).toBe(CommandIcon);
    expect(STEP_ICON.run).not.toBe(FlashIcon);
    expect(STEP_ICON.action).toBe(FlashIcon);
    expect(STEP_ICON.sleep).toBe(Clock01Icon);
    expect(STEP_ICON.ai).toBe(AiBrain01Icon);
    expect(STEP_ICON.ai).not.toBe(FlashIcon);
  });

  it("渲染 run 步的 label 与 kind 文案", () => {
    const steps: WorkflowStepInfo[] = [{ kind: "run", label: "echo hi", name: "" }];
    render(<WorkflowStepsOverview steps={steps} />);
    expect(screen.getByText("echo hi")).toBeInTheDocument();
    expect(screen.getByText("run")).toBeInTheDocument();
  });

  it("渲染 ai 步的 label 与 kind 文案", () => {
    const steps: WorkflowStepInfo[] = [{ kind: "ai", label: "claude-ask", name: "" }];
    render(<WorkflowStepsOverview steps={steps} />);
    expect(screen.getByText("claude-ask")).toBeInTheDocument();
    expect(screen.getByText("ai")).toBeInTheDocument();
  });
});
