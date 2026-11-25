import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Mock } from "vitest";

const { mockRunner, listeners, mockOn } = vi.hoisted(() => {
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    listeners,
    mockOn: vi.fn((name: string, cb: (e: unknown) => void) => {
      listeners[name] = cb;
      return () => { delete listeners[name]; };
    }),
    mockRunner: {
      currentRunId: "r1" as string | null,
      closeRun: vi.fn(),
      getRun: vi.fn(),
      getRunEvents: vi.fn(),
      runsRevision: 0,
      actions: [{ id: "build", title: "构建", icon: "" }],
      workflows: [] as Array<{ id: string; title: string; icon: string; steps: Array<{ name: string; kind: string; label: string }> }>,
      aiTasks: [{ id: "review-bot", title: "代码审查", icon: "" }],
    },
  };
});

vi.mock("../hooks/useActionRunner", () => ({
  useActionRunner: () => mockRunner,
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));
// 输出行渲染（OutputLines）为树节点的点击映射引用了绑定；这里不走真实绑定
vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ResolveTreeClick: vi.fn(),
  ResolveTreeClickMulti: vi.fn(),
}));

import { SidebarProvider } from "@/components/ui/sidebar";
import { RunDetailView } from "./RunDetailView";
import type { RunDetail, RunEvent } from "../types/events";

const detail = (extra: Partial<RunDetail> = {}): RunDetail => ({
  id: "r1",
  targetKind: "ai",
  targetId: "review-bot",
  origin: "manual",
  scheduleId: "",
  status: "succeeded",
  reason: "",
  startedAt: "2026-11-25T02:15:00.500+08:00",
  finishedAt: "2026-11-25T02:15:04.250+08:00",
  exitCode: 0,
  params: { prompt: "介绍一下 ${TOPIC}", TOPIC: "crash" },
  outputs: { session_id: "sess-1", cost_usd: "0.12", text: "你好，世界", thinking: "想了想" },
  rules: "# 无人值守守则\n无人可问，自行决断。",
  processMode: "in-app",
  processPid: 4321,
  processStartedAt: "2026-11-25T02:00:00.000+08:00",
  ...extra,
});

const out = (t: number, seq: number, stream: RunEvent["stream"] & string, line: string, step?: string): RunEvent =>
  step === undefined ? { t, event: "output", stream, line, seq } : { t, event: "output", stream, line, seq, step };
const done = (t: number, seq: number, extra: Partial<RunEvent> = {}): RunEvent =>
  ({ t, event: "done", seq, exitCode: 0, err: "", duration: "3.7s", ...extra });

function renderView() {
  return render(
    <SidebarProvider>
      <RunDetailView />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  mockRunner.currentRunId = "r1";
  mockRunner.runsRevision = 0;
  mockRunner.workflows = [];
  mockRunner.getRun.mockResolvedValue(detail());
  mockRunner.getRunEvents.mockResolvedValue([]);
});

describe("RunDetailView", () => {
  it("AI run: replays the process-segment panel from the run log and shows conclusion, outputs, inputs and rules", async () => {
    mockRunner.getRunEvents.mockResolvedValue([
      out(100, 1, "ai", "你好"),
      out(400, 2, "ai-thinking", "想了想"),
      out(410, 3, "ai-tool", JSON.stringify({ id: "t1", name: "Read", input: { file_path: "/repo/a.json" } })),
      out(900, 4, "ai-tool", JSON.stringify({ id: "t1", content: "ok" })),
      out(1000, 5, "ai", "，世界"),
      done(3700, 6, { readout: { durationMs: 3700, sessionId: "sess-1", costUsd: 0.12 } }),
    ]);
    renderView();

    // 结论区：目标、状态、起止、耗时、来源、退出码
    expect(await screen.findByText("代码审查")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
    expect(screen.getByText("3.8s")).toBeInTheDocument(); // 起止差 3.75s
    expect(screen.getByText("手动运行")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0); // 退出码
    expect(screen.getByText("r1")).toBeInTheDocument();

    // 过程：工序段面板（回复、思考、工具），提示词工单是当次的输入。
    // 回答被中间的思考 / 工具段分成两段（工序序列），各自成段。
    // 过程区晚于结论区到达（日志是第二步加载）：等它
    expect(await screen.findByText("你好")).toBeInTheDocument();
    expect(screen.getByText("，世界")).toBeInTheDocument();
    // 已结束的运行：思考段默认折叠（流式中才展开），点段头才看正文
    expect(screen.getByText("思考")).toBeInTheDocument();
    expect(screen.queryByText("想了想")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("思考"));
    expect(screen.getByText("想了想")).toBeInTheDocument();
    expect(screen.getByText(/Read/)).toBeInTheDocument();
    expect(screen.getByText("· a.json")).toBeInTheDocument();
    // 指令工单与输入表显示的都是运行记录里原样留存的输入（模板展开发生在后端，这里不复现）
    expect(screen.getAllByText("介绍一下 ${TOPIC}")).toHaveLength(2);
    // live 文案不出现：这是一次已结束的运行
    expect(screen.queryByText("生成中")).not.toBeInTheDocument();
    expect(screen.queryByText("思考中")).not.toBeInTheDocument();

    // 产出表：读数类产出在，正文类（text / thinking 已在过程里）不重复
    const outputs = screen.getByRole("table", { name: "产出" });
    expect(within(outputs).getByText("session_id")).toBeInTheDocument();
    expect(within(outputs).getByText("sess-1")).toBeInTheDocument();
    expect(within(outputs).queryByText("text")).not.toBeInTheDocument();
    // 输入表：当次的输入原样
    const inputs = screen.getByRole("table", { name: "输入" });
    expect(within(inputs).getByText("crash")).toBeInTheDocument();
    expect(within(inputs).queryByText("text")).not.toBeInTheDocument();
  });

  it("the injected rules are folded away until asked for", async () => {
    renderView();
    // 守则折叠按钮随日志一起渲染（详情与日志分两步加载）
    const trigger = await screen.findByText("本次注入的无人值守守则");
    expect(screen.queryByText(/无人可问，自行决断/)).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByText(/无人可问，自行决断/)).toBeInTheDocument();
  });

  it("过程区对 AI 长 JSON 输出收缩宽度：grid track/item 布局约束在位（防视图被拉宽）", async () => {
    // jsdom 无布局引擎量不到真实宽度，这里钉住布局契约：AI 工具段的 pre 是 whitespace-pre
    // 长行（单行 JSON 命令/结果可达上千字符），grid item 默认 min-width:auto 会被它的
    // min-content 撑到「最长行宽」，把整条过程区拉宽。容器必须有 grid-cols-1（minmax(0,1fr)
    // 轨道）与 min-w-0（item 收缩）才能真正受制于可用宽度。
    mockRunner.getRunEvents.mockResolvedValue([
      out(100, 1, "ai-tool", JSON.stringify({ id: "c1", name: "Bash", input: { command: "x".repeat(2000) } })),
      out(200, 2, "ai", JSON.stringify({ target_date: "2026-11-25", groups: { 已分析: [{ card_no: "edc-scrum-428286", title: "y".repeat(800) }] } })),
      done(3700, 3, { readout: { durationMs: 3700 } }),
    ]);
    renderView();
    await screen.findByText("代码审查");

    // 过程区晚于结论区到达（日志是第二步加载）：等面板落地再断言布局契约
    const section = await waitFor(() => {
      const el = document.querySelector('section[aria-labelledby="run-process-heading"]');
      expect(el).not.toBeNull();
      expect(el!.querySelector(".rounded-lg")).not.toBeNull();
      return el!;
    });
    expect(section.className).toContain("grid-cols-1");
    expect(section.className).toContain("min-w-0");
    // AI 过程面板容器（section 下的 grid item）同样可收缩
    expect(section.querySelector(".rounded-lg")!.className).toContain("min-w-0");
  });

  it("action run: replays output lines in order with the exit-code line last; long values fold", async () => {
    mockRunner.getRun.mockResolvedValue(detail({
      targetKind: "action", targetId: "build", params: { BRANCH: "main" },
      outputs: { exit_code: "0", success: "true", stdout: "hello", apk_sha: "x".repeat(300) }, rules: "",
    }));
    // stdout 先落盘但 seq 更大：回放按 seq 还原真实产出顺序
    mockRunner.getRunEvents.mockResolvedValue([
      out(1, 2, "stdout", "hello"),
      out(0, 1, "stderr", "warn"),
      done(20, 3, { exitCode: 0 }),
    ]);
    renderView();
    // 落盘顺序乱了也按 seq 还原；退出码行在最后
    const pre = (await screen.findByText(/--- 退出码 0 ---/)).closest("pre") as HTMLElement;
    expect(within(pre).getAllByText(/hello|warn/).map((node) => node.textContent)).toEqual(["[stderr] warn", "hello"]);
    // stdout 正文不进产出表，读数与自定义产出在
    expect(within(screen.getByRole("table", { name: "产出" })).queryByText("stdout")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "产出" })).getByText("success")).toBeInTheDocument();
    // 长值先折叠，点开看全文
    expect(screen.getByText(/^x{160}…$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(screen.getByText("x".repeat(300))).toBeInTheDocument();
    expect(screen.queryByText("展开")).not.toBeInTheDocument();
  });

  it("workflow run: replays the step spine with names taken from the current definition", async () => {
    mockRunner.workflows = [{
      id: "deploy", title: "部署", icon: "",
      steps: [{ name: "构建镜像", kind: "run", label: "docker build" }, { name: "审查", kind: "ai", label: "review-bot" }],
    }];
    mockRunner.getRun.mockResolvedValue(detail({ targetKind: "workflow", targetId: "deploy", params: {}, outputs: {}, rules: "", duration: undefined } as Partial<RunDetail>));
    mockRunner.getRunEvents.mockResolvedValue([
      out(0, 0, "step-start", "0", "0"),
      out(10, 0, "stdout", "docker build ok", "0"),
      out(100, 0, "step-done", "0:0", "0"),
      out(100, 0, "step-start", "1", "1"),
      out(300, 0, "ai", "可以发布", "1"),
      out(500, 0, "step-done", "1:0", "1"),
      { t: 600, event: "done", exitCode: 0, err: "", duration: "600ms" },
    ]);
    renderView();
    expect(await screen.findByText("构建镜像")).toBeInTheDocument();
    expect(screen.getByText("审查")).toBeInTheDocument();
    // 顺利完成的普通步骤默认折叠：点开才看输出
    expect(screen.queryByText("docker build ok")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("构建镜像"));
    expect(screen.getByText("docker build ok")).toBeInTheDocument();
    // AI 步骤同样是工序段
    expect(screen.getByText("可以发布")).toBeInTheDocument();
    // 已结束的运行：没有 live 标记
    expect(screen.queryByText(/实时/)).not.toBeInTheDocument();
  });

  it("a skipped run left no output and says why (same for every target kind)", async () => {
    for (const targetKind of ["ai", "action", "workflow"]) {
      mockRunner.getRun.mockResolvedValue(detail({
        status: "skipped", reason: "目标正在运行", exitCode: -1, targetKind, targetId: "x", outputs: {}, rules: "", params: {},
      }));
      const { unmount } = renderView();
      expect(await screen.findByText("已跳过")).toBeInTheDocument();
      expect(screen.getByText("目标正在运行")).toBeInTheDocument();
      expect(await screen.findByText(/没有留下输出/)).toBeInTheDocument();
      unmount();
    }
  });

  it("an interrupted run has no finish time: the UI says unknown instead of inventing a duration", async () => {
    mockRunner.getRun.mockResolvedValue(detail({
      status: "interrupted", reason: "应用退出时仍在运行，未能得出结果", exitCode: -1,
      finishedAt: "", outputs: {}, rules: "", params: {},
    }));
    renderView();
    expect(await screen.findByText("已中断")).toBeInTheDocument();
    expect(screen.getAllByText("不可知")).toHaveLength(2); // 结束时刻 + 耗时
    expect(screen.getByText(/应用退出时仍在运行/)).toBeInTheDocument();
  });

  it("a run still in flight with no output yet shows the live marker instead of the no-output note", async () => {
    mockRunner.getRun.mockResolvedValue(detail({ status: "running", finishedAt: "", outputs: {}, rules: "" }));
    renderView();
    expect(await screen.findByText(/实时/)).toBeInTheDocument();
    expect(screen.queryByText(/没有留下输出/)).not.toBeInTheDocument();
  });

  it("a failed run shows the reason and the error output", async () => {
    mockRunner.getRun.mockResolvedValue(detail({ status: "failed", reason: "退出码 3", exitCode: 3 }));
    mockRunner.getRunEvents.mockResolvedValue([
      out(0, 1, "stderr", "[skill-sync] 同步失败"),
      done(50, 2, { exitCode: 3, err: "CLI 未安装" }),
    ]);
    renderView();
    expect(await screen.findByText("退出码 3")).toBeInTheDocument();
    expect(await screen.findByText("运行失败")).toBeInTheDocument();
    expect(screen.getByText("CLI 未安装")).toBeInTheDocument();
    expect(screen.getAllByText("[stderr] [skill-sync] 同步失败").length).toBeGreaterThan(0);
  });

  it("flags a truncated run log", async () => {
    mockRunner.getRunEvents.mockResolvedValue([out(0, 1, "ai", "半截"), { t: 5, event: "truncated", limit: 100 }]);
    renderView();
    expect(await screen.findByText(/运行日志达到上限/)).toBeInTheDocument();
    expect(screen.getByText("半截")).toBeInTheDocument();
  });

  it("a running run is followed live: subscribes to the target's events, applies them, unsubscribes on close", async () => {
    mockRunner.getRun.mockResolvedValue(detail({ status: "running", finishedAt: "", outputs: {}, rules: "" }));
    mockRunner.getRunEvents.mockResolvedValue([out(0, 1, "ai", "已经落盘的")]);
    const { unmount } = renderView();
    await screen.findByText("已经落盘的");
    expect(screen.getByText(/实时/)).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();

    // 订阅的是该目标的输出 / 结束通道（与前端实时收到的事件同构）
    expect(mockOn).toHaveBeenCalledWith("ai:review-bot:output", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("ai:review-bot:done", expect.any(Function));
    // 实时事件在回放之上继续应用；与已落盘部分重叠的 seq 被帧门挡住，不重复
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    listeners["ai:review-bot:output"]?.({ data: { stream: "ai", line: "，还在写", seq: 1 } });
    listeners["ai:review-bot:output"]?.({ data: { stream: "ai", line: "，还在写", seq: 2 } });
    await waitFor(() => expect(screen.getByText("已经落盘的，还在写")).toBeInTheDocument());

    unmount();
    expect(listeners["ai:review-bot:output"]).toBeUndefined();
    expect(listeners["ai:review-bot:done"]).toBeUndefined();
  });

  it("subscribes before reading the log: output produced in between is neither lost nor duplicated", async () => {
    mockRunner.getRun.mockResolvedValue(detail({ status: "running", finishedAt: "", outputs: {}, rules: "" }));
    // 记下「订阅」与「读盘」的先后：订阅必须在读盘之前建立，否则读盘到订阅生效之间的输出两头落空
    const order: string[] = [];
    mockOn.mockImplementation((name: string, cb: (e: unknown) => void) => {
      order.push(`subscribe:${name}`);
      listeners[name] = cb;
      return () => { delete listeners[name]; };
    });
    let releaseLog!: (events: RunEvent[]) => void;
    mockRunner.getRunEvents.mockImplementation(() => {
      order.push("read");
      return new Promise<RunEvent[]>((resolve) => { releaseLog = resolve; });
    });
    renderView();
    // 结论区只依赖详情：日志还没回来就已显示，过程区显示加载中
    await screen.findByText("代码审查");
    await screen.findByText("运行中");
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    await waitFor(() => expect(order).toContain("read"));
    expect(order.indexOf("subscribe:ai:review-bot:output")).toBeLessThan(order.indexOf("read"));

    // 读盘还没返回：这期间到达的输出先排队，不丢
    listeners["ai:review-bot:output"]?.({ data: { stream: "ai", line: "，还在写", seq: 2 } });
    // 日志里也有它（读盘晚于它的产生）：快照落地后重送的那一份被 seq 跳过，不重复
    await act(async () => {
      releaseLog([out(0, 1, "ai", "已经落盘的"), out(5, 2, "ai", "，还在写")]);
    });
    expect(await screen.findByText("已经落盘的，还在写")).toBeInTheDocument();
    // 号段没有洞：之后的实时事件照常出队
    listeners["ai:review-bot:output"]?.({ data: { stream: "ai", line: "！", seq: 3 } });
    expect(await screen.findByText("已经落盘的，还在写！")).toBeInTheDocument();
  });

  it("an action run in flight is followed on the action channel", async () => {
    mockRunner.getRun.mockResolvedValue(detail({ status: "running", finishedAt: "", targetKind: "action", targetId: "build", outputs: {}, rules: "", params: {} }));
    renderView();
    await screen.findByText("构建");
    await waitFor(() => expect(mockOn).toHaveBeenCalledWith("action:build:output", expect.any(Function)));
  });

  it("goes back through closeRun, reloads when runsRevision changes, and surfaces a load failure", async () => {
    renderView();
    await screen.findByText("代码审查");
    expect(mockRunner.getRun).toHaveBeenCalledWith("r1");
    expect(mockRunner.getRunEvents).toHaveBeenCalledWith("r1");
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(mockRunner.closeRun).toHaveBeenCalledTimes(1);

    (mockRunner.getRun as Mock).mockRejectedValue(new Error("记录已清理"));
    mockRunner.runsRevision = 1;
    render(<SidebarProvider><RunDetailView /></SidebarProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("记录已清理");
  });

  it("renders nothing until the record arrives when there is no current run", () => {
    mockRunner.currentRunId = null;
    renderView();
    expect(screen.queryByText("过程")).not.toBeInTheDocument();
    expect(mockRunner.getRun).not.toHaveBeenCalled();
  });
});
