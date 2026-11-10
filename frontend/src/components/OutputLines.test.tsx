import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutputLines } from "./OutputLines";
import type { OutputLineItem } from "../types/events";

const { resolveTreeClick, runAction, isRunning } = vi.hoisted(() => ({
  resolveTreeClick: vi.fn(), runAction: vi.fn(), isRunning: vi.fn(),
}));
vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ResolveTreeClick: resolveTreeClick,
}));
vi.mock("../hooks/useActionRunner", () => ({
  useActionRunner: () => ({
    actions: [{ id: "browse", hmi: { tree: { click: { action: "download" } } } }],
    runAction, isRunning,
  }),
}));

const lines: OutputLineItem[] = [{
  kind: "tree", id: 0,
  frame: {
    nodes: [{ label: "root", kind: "dir", children: [{ label: "a.log", path: "logs/a.log" }] }],
    source: { actionId: "browse", params: { ZIP_NAME: "logs.zip" }, protocol: "script" },
  },
}];

beforeEach(() => {
  resolveTreeClick.mockReset().mockResolvedValue({ action: "download", params: { FILE: "logs/a.log" } });
  runAction.mockReset().mockResolvedValue(undefined);
  isRunning.mockReset().mockReturnValue(false);
});

describe("OutputLines tree click", () => {
  it("将来源参数和节点交给后端映射并运行目标动作", async () => {
    render(<OutputLines lines={lines} />);
    await userEvent.click(screen.getByText("a.log"));
    await waitFor(() => expect(runAction).toHaveBeenCalledWith("download", { FILE: "logs/a.log" }, false, ["FILE"]));
    expect(resolveTreeClick).toHaveBeenCalledWith("browse", { label: "a.log", path: "logs/a.log" }, { ZIP_NAME: "logs.zip" });
  });

  it("映射失败时保留原树且不执行动作", async () => {
    resolveTreeClick.mockRejectedValue(new Error("bad mapping"));
    render(<OutputLines lines={lines} />);
    await userEvent.click(screen.getByText("a.log"));
    expect(await screen.findByText("Error: bad mapping")).toBeInTheDocument();
    expect(runAction).not.toHaveBeenCalled();
    expect(screen.getByText("a.log")).toBeInTheDocument();
  });

  it("目标正在运行时保留原树", async () => {
    isRunning.mockReturnValue(true);
    render(<OutputLines lines={lines} />);
    await userEvent.click(screen.getByText("a.log"));
    await waitFor(() => expect(resolveTreeClick).toHaveBeenCalled());
    expect(runAction).not.toHaveBeenCalled();
  });
});
