import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

const { mockGetFragments, mockSetFragments, mockWriteText, listeners } = vi.hoisted(
  () => ({
    mockGetFragments: vi.fn(),
    mockSetFragments: vi.fn(() => Promise.resolve()),
    mockWriteText: vi.fn(() => Promise.resolve()),
    // 同名事件可能有多个订阅者（Provider 写输入框、FragmentsList 写变量 token），故按名存数组
    listeners: {} as Record<string, Array<(e: unknown) => void>>,
  }),
);

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
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
    </SidebarProvider>,
  );
}

// 标题即复制按钮：按「可访问名 = 片段标题」定位卡片上的主操作，
// 避开分区头副行（标题也出现在那里）。
const titleButton = (title: string) => screen.getByRole("button", { name: title });

describe("FragmentsView - 标签 Tab", () => {
  it("页签为「全部」+ 各标签（字母序、带数量），数量取全部片段统计、不受搜索影响", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "F1", content: "a", tags: ["adb"] },
      { title: "F2", content: "b", tags: ["rg"] },
      { title: "F3", content: "c", tags: ["adb", "logcat"] },
    ]);
    const user = userEvent.setup();
    renderView();
    const tabs = await screen.findAllByRole("tab");
    // 顺序：全部 → adb → logcat → rg（字母序）
    const names = tabs.map((el) => el.textContent ?? "");
    expect(names).toHaveLength(4);
    expect(names[0]).toMatch(/^全部/);
    expect(names[1]).toMatch(/^adb/);
    expect(names[2]).toMatch(/^logcat/);
    expect(names[3]).toMatch(/^rg/);
    // 数量 = 全部片段的统计（adb 2、logcat 1、全部 3）
    expect(within(tabs[0]).getByText("3")).toBeInTheDocument();
    expect(within(tabs[1]).getByText("2")).toBeInTheDocument();
    expect(within(tabs[2]).getByText("1")).toBeInTheDocument();

    // 搜索命中只剩 F2，页签数量不变
    await user.type(screen.getByPlaceholderText("搜索 标题 / 内容 / 标签"), "F2");
    expect(screen.getByRole("button", { name: "F2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "F1" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: /^adb/ })).getByText("2")).toBeInTheDocument();
  });

  it("没有任何标签时不渲染页签", async () => {
    mockGetFragments.mockResolvedValue([{ title: "x", content: "ls", tags: [] }]);
    renderView();
    expect(await screen.findByRole("button", { name: "x" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("点击标签页签后只剩该标签的片段", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "F1", content: "a", tags: ["adb"] },
      { title: "F2", content: "b", tags: ["rg"] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "F1" });
    await user.click(screen.getByRole("tab", { name: /^adb/ }));
    expect(screen.getByRole("button", { name: "F1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "F2" })).not.toBeInTheDocument();
  });

  it("选中的标签随最后一个片段消失自动回到「全部」", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "F1", content: "a", tags: ["adb"] },
      { title: "F2", content: "b", tags: ["rg"] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "F1" });
    await user.click(screen.getByRole("tab", { name: /^rg/ }));
    expect(screen.queryByRole("button", { name: "F1" })).not.toBeInTheDocument();

    // 两步确认删除唯一带 rg 标签的片段 → rg 页签消失，选区回到「全部」
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "再次点击确认删除" }));
    expect(await screen.findByRole("button", { name: "F1" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^rg/ })).not.toBeInTheDocument();
  });
});

describe("FragmentsView - 分区", () => {
  it("多 tag 片段只归首个 tag 分区且只出现一次，分区固定 data-amb=amber", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "看日志", content: "adb logcat", tags: ["adb", "logcat"] },
      { title: "杂项", content: "ls", tags: [] },
    ]);
    renderView();
    await screen.findByRole("button", { name: "看日志" });

    // adb 分区存在且为琥珀；logcat 不单独成分区
    const adbSec = document.querySelector('[data-sec="adb"]');
    expect(adbSec).not.toBeNull();
    expect(adbSec).toHaveAttribute("data-amb", "amber");
    expect(document.querySelector('[data-sec="logcat"]')).toBeNull();
    // 同一片段只出现一次（标题按钮唯一）
    expect(screen.getAllByRole("button", { name: "看日志" })).toHaveLength(1);

    // 无标签片段进「未分类」，同样固定琥珀
    const uncat = document.querySelector('[data-sec="未分类"]');
    expect(uncat).not.toBeNull();
    expect(uncat).toHaveAttribute("data-amb", "amber");
    expect(screen.getByRole("button", { name: "杂项" })).toBeInTheDocument();
  });

  it("分区头副行取前三个非空标题，超出加省略号", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "T1", content: "a", tags: ["adb"] },
      { title: "T2", content: "b", tags: ["adb"] },
      { title: "T3", content: "c", tags: ["adb"] },
      { title: "T4", content: "d", tags: ["adb"] },
      { title: "", content: "e", tags: ["adb"] },
    ]);
    renderView();
    await screen.findByRole("button", { name: "T1" });
    // 分区头按钮（可访问名 = 标签名 + 副行 + 计数）：前 3 个标题 + 「…」，空标题不进副行
    const head = screen.getByRole("button", { name: /T1 · T2 · T3 …/ });
    expect(head).not.toHaveAccessibleName(/T4/);
    expect(head).not.toHaveAccessibleName(/无标题/);
    expect(head).toHaveAttribute("aria-expanded", "true");
  });

  it("分区头可收起 / 展开", async () => {
    const user = userEvent.setup();
    mockGetFragments.mockResolvedValue([{ title: "F1", content: "a", tags: ["adb"] }]);
    renderView();
    await screen.findByRole("button", { name: "F1" });
    await user.click(screen.getByRole("button", { name: /adb/ }));
    // 收起后卡片隐藏，分区头仍在
    expect(screen.queryByRole("button", { name: "F1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /adb/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.click(screen.getByRole("button", { name: /adb/ }));
    expect(await screen.findByRole("button", { name: "F1" })).toBeInTheDocument();
  });
});

describe("FragmentsView - 片段卡片", () => {
  it("带 color 的卡片有对应 data-amb，不带的不设（跟随分区琥珀）", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "绿片段", content: "a", tags: ["adb"], color: "green" },
      { title: "素片段", content: "b", tags: ["adb"] },
    ]);
    renderView();
    await screen.findByRole("button", { name: "绿片段" });
    const greenCard = screen.getByRole("button", { name: "绿片段" }).closest("article");
    expect(greenCard).not.toBeNull();
    expect(greenCard).toHaveAttribute("data-amb", "green");
    const plainCard = screen.getByRole("button", { name: "素片段" }).closest("article");
    expect(plainCard).not.toBeNull();
    expect(plainCard).not.toHaveAttribute("data-amb");
  });

  it("卡片提示它还带的其它标签（+tag）", async () => {
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    // 看日志带 adb、logcat 两个标签，归在 adb 分区，提示另一个
    expect(screen.getByText("+logcat")).toBeInTheDocument();
  });

  it("点击标题即复制（展开变量后的命令）", async () => {
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.click(titleButton("看日志"));
    expect(mockWriteText).toHaveBeenCalledWith("adb logcat -d > /tmp/logs/today.log");
  });

  it("内容里 ${VAR} 按原样写法渲染：已定义琥珀字（title 为当前值）", async () => {
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    expect(screen.getByText("${LOGS_DIR}")).toBeInTheDocument();
    expect(screen.getByTitle("/tmp/logs")).toHaveTextContent("${LOGS_DIR}");
  });

  it("复制按钮仍复制展开结果（全局配置 + 本会话临时值）", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE} ${LOGS_DIR}", tags: [] },
    ]);
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByRole("button", { name: "x" });
    await user.click(screen.getByText("${NOPE}"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "/tmp/foo.apk{Enter}");
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(mockWriteText).toHaveBeenCalledWith("echo /tmp/foo.apk /tmp/logs");
  });

  it("搜索命中标题 / 内容 / 任一标签", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "看日志", content: "adb logcat", tags: ["adb"] },
      { title: "清理", content: "rm -rf tmp", tags: ["clean"] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.type(
      screen.getByPlaceholderText("搜索 标题 / 内容 / 标签"),
      "清理",
    );
    expect(screen.getByRole("button", { name: "清理" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "看日志" })).not.toBeInTheDocument();
  });

  it("搜索无结果时显示空态", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.type(screen.getByPlaceholderText("搜索 标题 / 内容 / 标签"), "zzz");
    expect(screen.getByText("没有匹配的片段")).toBeInTheDocument();
  });
});

describe("FragmentsView - 新增/编辑弹窗", () => {
  it("点新增打开空白弹窗，填写后保存追加到列表，载荷带默认颜色 amber", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
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
      { title: "新片段", content: "echo hi", tags: [], color: "amber" },
    ]);
  });

  it("点编辑打开弹窗并预填现有值，保存后替换该条（未选过色 → 默认 amber）", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
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
        color: "amber",
      },
    ]);
  });

  it("编辑改色后保存：载荷带新颜色且其它字段不变", async () => {
    mockGetFragments.mockResolvedValue([
      {
        title: "看日志",
        content: "adb logcat -d > ${LOGS_DIR}/today.log",
        tags: ["adb", "logcat"],
        color: "green",
      },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.click(screen.getByRole("button", { name: "编辑" }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "青色" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSetFragments).toHaveBeenCalledTimes(1);
    expect(mockSetFragments).toHaveBeenCalledWith([
      {
        title: "看日志",
        content: "adb logcat -d > ${LOGS_DIR}/today.log",
        tags: ["adb", "logcat"],
        color: "cyan",
      },
    ]);
  });

  it("弹窗展示五色色卡与实时预览卡（data-amb 跟随选中色，标题跟随输入）", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.click(screen.getByRole("button", { name: "新增" }));

    const dialog = screen.getByRole("dialog");
    // 五色色卡（shared 卡片颜色）
    const group = within(dialog).getByRole("radiogroup", { name: "卡片颜色" });
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
    expect(within(group).getByRole("radio", { name: "琥珀" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // 预览卡默认琥珀，输入标题后实时反映
    const preview = () => dialog.querySelector("article[data-amb]");
    expect(preview()).toHaveAttribute("data-amb", "amber");
    expect(preview()).toHaveTextContent("示例片段");
    await user.type(screen.getByLabelText("标题"), "预览标题");
    expect(preview()).toHaveTextContent("预览标题");

    // 改选紫色 → 预览卡变色
    await user.click(within(group).getByRole("radio", { name: "紫色" }));
    expect(preview()).toHaveAttribute("data-amb", "violet");
  });

  it("弹窗内展示引用的变量并标注是否已定义", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.click(screen.getByRole("button", { name: "编辑" }));
    // 限定在弹窗内查，避开列表里同名的 token
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("引用")).toBeInTheDocument();
    expect(dialog.getByText("LOGS_DIR")).toBeInTheDocument();
  });

  it("弹窗内 TagInput 支持整段带空格的 tag，取消不落盘", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.click(screen.getByRole("button", { name: "编辑" }));

    await user.type(screen.getByLabelText("添加标签（回车确认）"), "Lanv AI_BOX{Enter}");
    expect(screen.getByText("Lanv AI_BOX")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(mockSetFragments).not.toHaveBeenCalled();
    // 关闭后原列表未受影响
    expect(screen.getByRole("button", { name: "看日志" })).toBeInTheDocument();
  });
});

describe("FragmentsView - 删除", () => {
  it("需二次点击才真正删除", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });

    const del = screen.getByRole("button", { name: "删除" });
    await user.click(del);
    expect(mockSetFragments).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "再次点击确认删除" }));
    expect(mockSetFragments).toHaveBeenCalledWith([]);
  });
});

describe("FragmentsView - 缺失变量就地填写", () => {
  it("点击缺失变量 token 后出现输入框", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "x" });
    await user.click(screen.getByText("${NOPE}"));
    expect(screen.getByRole("textbox", { name: "NOPE" })).toBeInTheDocument();
  });

  it("输入值后 Enter 提交，token 显示填入的值", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "x" });
    await user.click(screen.getByText("${NOPE}"));
    const input = screen.getByRole("textbox", { name: "NOPE" });
    await user.type(input, "/tmp/foo.apk{Enter}");
    expect(screen.getByText("/tmp/foo.apk")).toBeInTheDocument();
    expect(screen.queryByText("${NOPE}")).not.toBeInTheDocument();
  });

  it("Esc 取消编辑，token 复原为 ${VAR} 原样", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "x" });
    await user.click(screen.getByText("${NOPE}"));
    const input = screen.getByRole("textbox", { name: "NOPE" });
    await user.type(input, "abc{Escape}");
    expect(screen.getByText("${NOPE}")).toBeInTheDocument();
    expect(screen.queryByText("abc")).not.toBeInTheDocument();
  });

  it("已定义的琥珀 token 点击无反应，不出现输入框", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "看日志" });
    await user.click(screen.getByText("${LOGS_DIR}"));
    expect(screen.queryByRole("textbox", { name: "LOGS_DIR" })).not.toBeInTheDocument();
  });

  it("填写变量后，缺变量提示行消失；未填时提示行列出缺失", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("button", { name: "x" });
    expect(await screen.findByText(/缺变量.*NOPE/)).toBeInTheDocument();

    await user.click(screen.getByText("${NOPE}"));
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
    await screen.findByRole("button", { name: "x" });
    await user.click(screen.getByText("${NOPE}"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "filled{Enter}");
    expect(screen.getByText("filled")).toBeInTheDocument();

    // 删除第二条片段（y），触发二次确认删除流程
    const delBtns = screen.getAllByRole("button", { name: "删除" });
    await user.click(delBtns[1]);
    await user.click(screen.getByRole("button", { name: "再次点击确认删除" }));

    // x 仍在，但它的临时值应已被清空（索引语义已变，安全起见整体清空）
    expect(await screen.findByText("${NOPE}")).toBeInTheDocument();
    expect(screen.queryByText("filled")).not.toBeInTheDocument();
  });
});

describe("FragmentsView - 变量 token 拖拽赋值", () => {
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

  it("拖到未定义变量 token 上 → 直接填入并提交，不经过编辑态", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "装包", content: "adb install ${APK}", tags: [] },
    ]);
    renderView();
    const token = await screen.findByText("${APK}");

    dropOn(token, ["/a/app.apk"]);

    // 红字变琥珀：token 直接显示填入的值
    expect(screen.getByText("/a/app.apk")).toBeInTheDocument();
    expect(screen.queryByText("${APK}")).not.toBeInTheDocument();
    // 未进编辑态：没有出现该变量对应的输入框
    expect(screen.queryByRole("textbox", { name: "APK" })).not.toBeInTheDocument();
  });

  it("多路径按文本规则拼接，含空格的加引号", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "推文件", content: "adb push ${SRC} /sdcard/", tags: [] },
    ]);
    renderView();
    const token = await screen.findByText("${SRC}");

    dropOn(token, ["/a/x.txt", "/b/My Docs/y.txt"]);

    expect(screen.getByText('/a/x.txt "/b/My Docs/y.txt"')).toBeInTheDocument();
  });

  it("落在全局配置已定义的只读 token 上 → 不接收，值不变", async () => {
    renderView();
    // LOGS_DIR 已在全局配置定义，渲染为只读 span，没有 data-drop-var
    const readonlyToken = await screen.findByText("${LOGS_DIR}");

    dropOn(readonlyToken, ["/tmp/hijack"]);

    expect(screen.getByText("${LOGS_DIR}")).toBeInTheDocument();
    expect(screen.queryByText("/tmp/hijack")).not.toBeInTheDocument();
  });
});
