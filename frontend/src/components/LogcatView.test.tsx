import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListActions, mockRunAction, mockUpdateLogcatFilter, mockOn } = vi.hoisted(() => {
  return {
    mockListActions: vi.fn(),
    mockRunAction: vi.fn(() => Promise.resolve()),
    mockUpdateLogcatFilter: vi.fn(
      (_id: string, _rule: unknown, _reset: boolean) => Promise.resolve(),
    ),
    // 事件注入走 Provider 的 _emitForTest，这里只需返回一个 unsubscribe。
    mockOn: vi.fn(() => () => {}),
  };
});

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: mockRunAction,
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  PickFile: vi.fn().mockResolvedValue(""),
  GetActionYaml: vi.fn().mockResolvedValue(""),
  SetActionYaml: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
  UpdateLogcatFilter: mockUpdateLogcatFilter,
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { LogcatView } from "./LogcatView";
import type { LogcatEntry } from "../types/events";

// harness：组件测试里没有 result.current，用它把 context 暴露给测试
let runner: ReturnType<typeof useActionRunner> | null = null;
function Harness() {
  runner = useActionRunner();
  return <LogcatView />;
}

const entry = (over: Partial<LogcatEntry> = {}): LogcatEntry => ({
  date: "09-03",
  time: "17:08:42.780",
  pid: 4321,
  tid: 4321,
  level: "I",
  tag: "AudioEffect",
  message: "cmdCode = 65536",
  ...over,
});

// 启动 logcat 动作并用 replace head 帧注入日志行：head 帧直接落 state
// （applyLogcatReplace），绕开 Provider 那个 120ms 增量定时器，省掉 fake timer。
async function startWithEntries(entries: LogcatEntry[]) {
  mockListActions.mockResolvedValue({
    actions: [
      { id: "a1", title: "Logcat", icon: "", description: "", params: [], presets: [], stream: "logcat" },
    ],
    errors: [],
  });
  render(
    <ThemeProvider>
      <ActionRunnerProvider>
        <SidebarProvider>
          <Harness />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>,
  );
  await act(() => Promise.resolve());
  await act(async () => {
    await runner!.runAction("a1", {});
  });
  act(() => {
    _emitForTest("action:a1:output", {
      data: {
        stream: "logcat-replace",
        line: JSON.stringify({
          head: true,
          entries,
          matched: entries.length,
          total: entries.length,
          tagHistogram: {},
        }),
      },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runner = null;
});

describe("LogcatView 控制甲板", () => {
  // 回归：草稿 token（未敲空格固化的输入）不能被走 committed 的编辑吞掉。
  // 原实现 setTokens 只写 committed，点行内 pid 会让正在输入的条件从规则里蒸发，
  // 输入框文字却还在——看着仍生效，实际过滤已放宽。
  it("未固化的草稿在点击行内 pid 后仍留在规则里", async () => {
    const user = userEvent.setup();
    await startWithEntries([entry()]);

    const input = screen.getByPlaceholderText(/裸词/);
    await user.type(input, "tag:foo");
    await user.click(screen.getByTitle("点击：只看此进程"));

    // 把 300ms 防抖窗口 + 随后的 UpdateLogcatFilter promise 落地一起纳入 act，
    // 否则 Provider 的 setLogcatFilterError 会在 act 外触发 React 警告。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(input).toHaveValue("tag:foo");
    await vi.waitFor(
      () =>
        expect(mockUpdateLogcatFilter).toHaveBeenLastCalledWith(
          "a1",
          {
            tokens: [
              { key: "pid", op: "exact", negated: false, value: "4321", link: "" },
              { key: "tag", op: "contains", negated: false, value: "foo", link: "" },
            ],
            minLevel: "V",
            package: "",
          },
          false,
        ),
      { timeout: 2000 },
    );
  });

  // 回归：草稿带回 setTokens 后，固化（空格）路径不能把同一条件重复写进规则——
  // commitInput 里的 toks 正是草稿的固化形态，追加 drafts 会让它进两遍。
  it("空格固化后规则里不留重复的草稿 token", async () => {
    const user = userEvent.setup();
    await startWithEntries([entry()]);

    const input = screen.getByPlaceholderText(/裸词/);
    await user.type(input, "tag:foo ");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(input).toHaveValue("");
    await vi.waitFor(
      () =>
        expect(mockUpdateLogcatFilter).toHaveBeenLastCalledWith(
          "a1",
          {
            tokens: [
              { key: "tag", op: "contains", negated: false, value: "foo", link: "" },
            ],
            minLevel: "V",
            package: "",
          },
          false,
        ),
      { timeout: 2000 },
    );
  });

  // spec:78 草稿态：未固化文本要以虚线边框 chip 形态呈现。输入框本身就是那个
  // 虚线 chip——不另画 Chip，避免同一段文本渲染两遍。
  it("有未固化文本时输入框呈虚线 chip 形态", async () => {
    const user = userEvent.setup();
    await startWithEntries([entry()]);

    const input = screen.getByPlaceholderText(/裸词/);
    const shell = input.parentElement!;
    expect(shell.className).toContain("border-transparent");
    expect(shell.className).not.toContain("border-dashed");

    await user.type(input, "tag:foo");
    expect(shell.className).toContain("border-dashed");
  });
});
