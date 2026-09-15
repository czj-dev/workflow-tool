import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
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
// presets 可选注入（预设点击路径的测试用）。
async function startWithEntries(
  entries: LogcatEntry[],
  presets: Array<{ name: string; description: string; values: Record<string, string> }> = [],
  tagHistogram: Record<string, number> = {},
) {
  mockListActions.mockResolvedValue({
    actions: [
      { id: "a1", title: "Logcat", icon: "", description: "", params: [], presets, stream: "logcat" },
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
          tagHistogram,
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

  // 回归：长 tag（手车互联预设的 DVR_PhoneLinkFallbackContextProvider，35 字符
  // ≈ 252px > chip max-w-64）曾因值 span 是 inline 元素（max-width/overflow 不生效）
  // 溢出 chip 边框，在面板中压到右侧相邻的 DVR_TinnoveIpc chip。截断需要整条链：
  // 菜单按钮 flex+min-w-0（可收缩 + 子元素 blockified），值 span min-w-0+truncate。
  it("长 tag chip 在自身内截断（不溢出压到相邻 chip）", async () => {
    const user = userEvent.setup();
    await startWithEntries(
      [entry({ tag: "DVR_PhoneLinkFallbackContextProvider" })],
      [
        {
          name: "手车互联",
          description: "",
          values: {
            EXCLUDE: "",
            INCLUDE: "",
            LEVEL: "V",
            PACKAGE: "",
            TAG: "DVR_PhoneLinkArb DVR_ThirdAppAgentDeviceModule DVR_PhoneLinkFallbackContextProvider DVR_TinnoveIpc",
          },
        },
      ],
      {
        DVR_PhoneLinkFallbackContextProvider: 99,
        DVR_TinnoveIpc: 38,
      },
    );
    await user.click(screen.getByRole("button", { name: "手车互联" }));
    // 落地 300ms 防抖窗口 + UpdateLogcatFilter promise，与上方回归用例同构
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // 菜单按钮（同一长 tag 文本在 chip/快捷条/日志区三处出现，用 title 精确定位）：
    // flex 容器（子 span 才会被 blockified 成可截断的盒子）+ min-w-0，title 附全文
    const menuBtn = screen.getByTitle(
      "点击：取反 / 转正则 / 分组 / 删除 · tag:DVR_PhoneLinkFallbackContextProvider",
    );
    expect(menuBtn.className).toContain("flex");
    expect(menuBtn.className).toContain("min-w-0");
    // 值 span：flex item + 可收缩 + 截断（inline 时三件套全部无效）
    const longVal = within(menuBtn).getByText(
      "DVR_PhoneLinkFallbackContextProvider",
    );
    expect(longVal.className).toContain("min-w-0");
    expect(longVal.className).toContain("truncate");

    // 快捷条（top-4 tag）同构截断：值 span min-w-0 truncate，title 附全文
    // （回归前：无截断无换行，最坏 4×35 字符 tag 溢出控制台行 258px）
    const quickBtn = screen.getByTitle(
      "点击加入/移除精确 tag · DVR_PhoneLinkFallbackContextProvider",
    );
    expect(quickBtn.className).toContain("max-w-40");
    const quickVal = quickBtn.querySelector("span")!;
    expect(quickVal.className).toContain("min-w-0");
    expect(quickVal.className).toContain("truncate");

    // 日志区 tag 列（9rem 截断）：title 带全文，悬停可读完整 tag
    expect(
      screen.getByTitle(
        "DVR_PhoneLinkFallbackContextProvider · 点击：只看此 tag",
      ),
    ).toBeTruthy();
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

// ——— marks 命中高亮（协议：docs/superpowers/specs/2026-09-15-logcat-marks-highlight.md）
// 行内命中段/命中 pid 整格 background: var(--mark-N)（半透明）；chip 色点
// var(--mark-h-N)（实色）。两者 style 都含 "--mark-" 前缀，取行内高亮需排除色点。
const rowMarks = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[style*="--mark-"]')).filter(
    (el) => !(el.getAttribute("style") ?? "").includes("--mark-h-"),
  );

describe("LogcatView 命中高亮", () => {
  // 协议四元组 [t,f,s,l]：t=token 序位（定色）、f=域（0 message/1 tag/2 pid）、
  // s/l 为 UTF-16 码元偏移/长度。这里验证三域各自落位与序位色。
  it("message/tag 命中段与 pid 整格渲染为对应序位色背景", async () => {
    await startWithEntries([
      entry({
        marks: [
          [0, 0, 0, 7], // token0 → message 域 "cmdCode"
          [0, 1, 0, 5], // token0 → tag 域 "Audio"
          [0, 2, 0, 4], // token0 → pid 域整格
        ],
      }),
    ]);

    const msg = rowMarks().find((el) => el.textContent === "cmdCode");
    expect(msg).toBeTruthy();
    expect(msg!.style.background).toBe("var(--mark-1)");

    const tag = rowMarks().find((el) => el.textContent === "Audio");
    expect(tag).toBeTruthy();
    expect(tag!.style.background).toBe("var(--mark-1)");

    const pidBtn = screen.getByTitle("点击：只看此进程");
    expect(pidBtn.style.background).toBe("var(--mark-1)");
  });

  // 图例：固化 chip 的色点与行内高亮同序位取色（实色变体），色点即「颜色↔条件」对照。
  it("固化 chip 带同序位色点（token0 → --mark-h-1）", async () => {
    const user = userEvent.setup();
    await startWithEntries([entry()]);

    const input = screen.getByPlaceholderText(/裸词/);
    await user.type(input, "cmdCode ");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    const dot = document.querySelector<HTMLElement>('[style*="--mark-h-1"]');
    expect(dot).toBeTruthy();
    expect(screen.getByTitle(/cmdCode/)).toBeTruthy();
  });

  // 规则被后端拒绝时后端已回退为不过滤，marks 与用户所见规则不再同源——
  // 行内高亮必须整体熄灭；chip 色点是纯前端图例，不受影响。
  it("后端拒绝规则（logcatFilterError）时行内高亮熄灭，chip 色点保留", async () => {
    const user = userEvent.setup();
    await startWithEntries([entry({ marks: [[0, 0, 0, 7]] })]);
    expect(rowMarks().length).toBeGreaterThan(0);

    mockUpdateLogcatFilter.mockReset();
    mockUpdateLogcatFilter.mockRejectedValue(new Error("RE2 不支持该语法"));
    const input = screen.getByPlaceholderText(/裸词/);
    await user.type(input, "tag:foo ");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(rowMarks().length).toBe(0);
    expect(
      document.querySelector<HTMLElement>('[style*="--mark-h-"]'),
    ).toBeTruthy();
    expect(screen.getByText(/RE2 不支持该语法/)).toBeTruthy();
  });
});
