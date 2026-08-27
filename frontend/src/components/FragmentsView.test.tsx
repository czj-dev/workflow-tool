import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

const { mockGetFragments, mockSetFragments, mockWriteText, listeners } = vi.hoisted(
  () => ({
    mockGetFragments: vi.fn(),
    mockSetFragments: vi.fn(() => Promise.resolve()),
    mockWriteText: vi.fn(() => Promise.resolve()),
    // 同名事件可能有多个订阅者（Provider 写输入框、FragmentsList 写变量 pill），故按名存数组
    listeners: {} as Record<string, Array<(e: unknown) => void>>,
  }),
);

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({ LOGS_DIR: "/tmp/logs" }),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: mockGetFragments,
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: mockSetFragments,
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (name: string, cb: (e: unknown) => void) => {
      (listeners[name] ??= []).push(cb);
      return () => {};
    },
  },
}));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { FragmentsView } from "./FragmentsView";

const sample = [
  {
    title: "看日志",
    content: "adb logcat -d > ${LOGS_DIR}/today.log",
    tags: ["adb", "logcat"],
  },
];

function stubClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockWriteText },
    configurable: true,
  });
}

beforeEach(async () => {
  mockGetFragments.mockReset().mockResolvedValue(sample);
  mockSetFragments.mockReset().mockResolvedValue(undefined);
  mockWriteText.mockReset().mockResolvedValue(undefined);
  Reflect.ownKeys(listeners).forEach((k) => Reflect.deleteProperty(listeners, k));
  stubClipboard();
  await i18n.changeLanguage("zh");
});

function renderView() {
  return render(
    <SidebarProvider>
      <ActionRunnerProvider>
        <FragmentsView />
      </ActionRunnerProvider>
    </SidebarProvider>
  );
}

describe("FragmentsView - 列表浏览", () => {
  it("多 tag 片段只归到首个 tag 组，不重复显示", async () => {
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    // 未选 tag 时按第一个 tag(adb) 归组，logcat 不单独成组
    expect(
      screen.getByRole("heading", { level: 3, name: /adb/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: /^logcat/i }),
    ).not.toBeInTheDocument();
    // 同一片段只出现一次
    expect(screen.getAllByText("看日志")).toHaveLength(1);
  });

  it("变量已定义时渲染为内联 pill，未命中的以缺变量提示列出", async () => {
    renderView();
    await screen.findByText("看日志");
    // LOGS_DIR 已在全局配置定义，渲染为 pill 而非纯文本替换
    expect(screen.getByText("LOGS_DIR")).toBeInTheDocument();
  });

  it("复制时把 ${VAR} 替换为全局配置的值", async () => {
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    const btns = screen.getAllByRole("button", { name: "复制" });
    await user.click(btns[0]);
    expect(mockWriteText).toHaveBeenCalledWith(
      "adb logcat -d > /tmp/logs/today.log"
    );
  });

  it("未命中的变量复制时保留原样，并在提示行列出缺失", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByText("x");
    expect(await screen.findByText(/缺变量.*NOPE/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(mockWriteText).toHaveBeenCalledWith("echo ${NOPE}");
  });

  it("无 tag 的片段归入「未分类」", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "杂项", content: "ls", tags: [] },
    ]);
    renderView();
    expect(await screen.findByText("未分类")).toBeInTheDocument();
    expect(screen.getByText("杂项")).toBeInTheDocument();
  });

  it("搜索过滤片段（标题/内容/标签）", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "看日志", content: "adb logcat", tags: ["adb"] },
      { title: "清理", content: "rm -rf tmp", tags: ["clean"] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.type(
      screen.getByPlaceholderText("搜索 标题 / 内容 / 标签"),
      "清理",
    );
    expect(screen.getByText("清理")).toBeInTheDocument();
    expect(screen.queryByText("看日志")).not.toBeInTheDocument();
  });

  it("点击 Tag 筛选只剩该 Tag 的片段", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "F1", content: "a", tags: ["adb"] },
      { title: "F2", content: "b", tags: ["rg"] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("F1");
    // 点 adb chip → 只剩 F1，F2 消失
    await user.click(screen.getByRole("button", { name: /adb/i }));
    expect(screen.getByText("F1")).toBeInTheDocument();
    expect(screen.queryByText("F2")).not.toBeInTheDocument();
  });
});

describe("FragmentsView - 新增/编辑弹窗", () => {
  it("点新增打开空白弹窗，填写后保存追加到列表", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.getByText("新增片段")).toBeInTheDocument();
    await user.type(screen.getByLabelText("标题"), "新片段");
    await user.type(
      screen.getByLabelText("指令内容，支持 ${VAR} 变量"),
      "echo hi",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSetFragments).toHaveBeenCalledWith([
      sample[0],
      { title: "新片段", content: "echo hi", tags: [] },
    ]);
  });

  it("点编辑打开弹窗并预填现有值，保存后替换该条", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.click(screen.getByRole("button", { name: "编辑" }));

    expect(screen.getByText("编辑片段")).toBeInTheDocument();
    const titleInput = screen.getByDisplayValue("看日志");
    await user.type(titleInput, "2");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSetFragments).toHaveBeenCalledWith([
      {
        title: "看日志2",
        content: "adb logcat -d > ${LOGS_DIR}/today.log",
        tags: ["adb", "logcat"],
      },
    ]);
  });

  it("弹窗内展示引用的变量并标注是否已定义", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.click(screen.getByRole("button", { name: "编辑" }));
    // 限定在弹窗内查，避开列表里同名的内联 pill
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("引用")).toBeInTheDocument();
    expect(dialog.getByText("LOGS_DIR")).toBeInTheDocument();
  });

  it("弹窗内 TagInput 支持整段带空格的 tag，取消不落盘", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.click(screen.getByRole("button", { name: "编辑" }));

    await user.type(screen.getByLabelText("添加标签（回车确认）"), "Lanv AI_BOX{Enter}");
    expect(screen.getByText("Lanv AI_BOX")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(mockSetFragments).not.toHaveBeenCalled();
    // 关闭后原列表未受影响
    expect(screen.getByText("看日志")).toBeInTheDocument();
  });
});

describe("FragmentsView - 删除", () => {
  it("需二次点击才真正删除", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");

    const del = screen.getByRole("button", { name: "删除" });
    await user.click(del);
    expect(mockSetFragments).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "再次点击确认删除" }));
    expect(mockSetFragments).toHaveBeenCalledWith([]);
  });
});

describe("FragmentsView - 缺失变量就地填写", () => {
  it("点击缺失变量 pill 后出现输入框", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    expect(screen.getByRole("textbox", { name: "NOPE" })).toBeInTheDocument();
  });

  it("输入值后 Enter 提交，pill 显示填入的值", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    const input = screen.getByRole("textbox", { name: "NOPE" });
    await user.type(input, "/tmp/foo.apk{Enter}");
    expect(screen.getByText("/tmp/foo.apk")).toBeInTheDocument();
    expect(screen.queryByText("NOPE")).not.toBeInTheDocument();
  });

  it("Esc 取消编辑，pill 复原为变量名", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    const input = screen.getByRole("textbox", { name: "NOPE" });
    await user.type(input, "abc{Escape}");
    expect(screen.getByText("NOPE")).toBeInTheDocument();
    expect(screen.queryByText("abc")).not.toBeInTheDocument();
  });

  it("已定义的琥珀 pill 点击无反应，不出现输入框", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.click(screen.getByText("LOGS_DIR"));
    expect(screen.queryByRole("textbox", { name: "LOGS_DIR" })).not.toBeInTheDocument();
  });

  it("复制时合并临时填写的值，未填的仍保留 ${VAR}", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE} ${LOGS_DIR}", tags: [] },
    ]);
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "/tmp/foo.apk{Enter}");

    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(mockWriteText).toHaveBeenCalledWith("echo /tmp/foo.apk /tmp/logs");
  });

  it("填写变量后，缺变量提示行消失", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    expect(await screen.findByText(/缺变量.*NOPE/)).toBeInTheDocument();

    await user.click(screen.getByText("NOPE"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "val{Enter}");
    expect(screen.queryByText(/缺变量/)).not.toBeInTheDocument();
  });

  it("删除片段后，临时填写的变量值被清空", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
      { title: "y", content: "echo ${ALSO_NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "filled{Enter}");
    expect(screen.getByText("filled")).toBeInTheDocument();

    // 删除第二条片段（y），触发二次确认删除流程
    const delBtns = screen.getAllByRole("button", { name: "删除" });
    await user.click(delBtns[1]);
    await user.click(screen.getByRole("button", { name: "再次点击确认删除" }));

    // x 仍在，但它的临时值应已被清空（索引语义已变，安全起见整体清空）
    expect(await screen.findByText("NOPE")).toBeInTheDocument();
    expect(screen.queryByText("filled")).not.toBeInTheDocument();
  });
});

describe("FragmentsView - 变量 pill 拖拽赋值", () => {
  // 落点由坐标决定，jsdom 没有布局也没实现 elementFromPoint，直接替身成「命中指定元素」
  const dropOn = (el: Element, paths: string[]) => {
    document.elementFromPoint = (() => el) as typeof document.elementFromPoint;
    act(() => {
      // Provider 与 FragmentsList 都订阅了 file:dropped，全部触发以还原真实运行时
      (listeners["file:dropped"] ?? []).forEach((cb) =>
        cb({ data: { paths, x: 1, y: 1 } }),
      );
    });
  };

  it("拖到未定义变量 pill 上 → 直接填入并提交，不经过编辑态", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "装包", content: "adb install ${APK}", tags: [] },
    ]);
    renderView();
    const pill = await screen.findByText("APK");

    dropOn(pill, ["/a/app.apk"]);

    // 红框变琥珀：pill 直接显示填入的值
    expect(screen.getByText("/a/app.apk")).toBeInTheDocument();
    expect(screen.queryByText("APK")).not.toBeInTheDocument();
    // 未进编辑态：没有出现该变量对应的输入框
    expect(screen.queryByRole("textbox", { name: "APK" })).not.toBeInTheDocument();
  });

  it("多路径按文本规则拼接，含空格的加引号", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "推文件", content: "adb push ${SRC} /sdcard/", tags: [] },
    ]);
    renderView();
    const pill = await screen.findByText("SRC");

    dropOn(pill, ["/a/x.txt", "/b/My Docs/y.txt"]);

    expect(screen.getByText('/a/x.txt "/b/My Docs/y.txt"')).toBeInTheDocument();
  });

  it("落在全局配置已定义的只读 pill 上 → 不接收，值不变", async () => {
    renderView();
    // LOGS_DIR 已在全局配置定义，渲染为只读 span，没有 data-drop-var
    const readonlyPill = await screen.findByText("LOGS_DIR");

    dropOn(readonlyPill, ["/tmp/hijack"]);

    expect(screen.getByText("LOGS_DIR")).toBeInTheDocument();
    expect(screen.queryByText("/tmp/hijack")).not.toBeInTheDocument();
  });
});
