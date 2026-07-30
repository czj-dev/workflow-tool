import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useEffect } from "react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [
      {
        id: "a1",
        title: "A",
        icon: "▶",
        description: "",
        params: [],
        presets: [],
        stream: "llm",
      },
    ],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { LlmView } from "./LlmView";

// 挂载后触发 runAction（建立事件订阅），再由外部 _emitForTest 注入 llm 文本
function Drive() {
  const { runAction } = useActionRunner();
  useEffect(() => {
    runAction("a1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <LlmView />;
}

describe("LlmView", () => {
  it("渲染 llmText 文本", async () => {
    render(
      <ActionRunnerProvider>
        <Drive />
      </ActionRunnerProvider>
    );
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "llm", line: "你好，世界" } });
    });
    expect(await screen.findByText(/你好/)).toBeInTheDocument();
  });
});
