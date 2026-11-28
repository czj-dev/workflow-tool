import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import zh from "../i18n/locales/zh.json";
import en from "../i18n/locales/en.json";
import type { VariableGroup } from "../../bindings/workflow-tool/internal/registry/models.js";

const {
  mockGetGlobalConfig,
  mockSetGlobalConfig,
  mockGetFragments,
  mockGetVarRefCounts,
  mockGetVariableGroups,
  mockSetVariableGroups,
} = vi.hoisted(() => ({
  mockGetGlobalConfig: vi.fn(() => Promise.resolve({})),
  mockSetGlobalConfig: vi.fn(() => Promise.resolve()),
  mockGetFragments: vi.fn(),
  mockGetVarRefCounts: vi.fn(() => Promise.resolve({})),
  mockGetVariableGroups: vi.fn((): Promise<VariableGroup[]> => Promise.resolve([])),
  // 回显规整结果：后端 SetVariableGroups 写入后返回规整列表，mock 同口径
  mockSetVariableGroups: vi.fn((groups: VariableGroup[]) => Promise.resolve(groups)),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: mockGetGlobalConfig,
  SetGlobalConfig: mockSetGlobalConfig,
  GetVarReferenceCounts: mockGetVarRefCounts,
  GetFragments: mockGetFragments,
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
  // 变量分组绑定（页面级，不进 Provider 启动加载）
  GetVariableGroups: mockGetVariableGroups,
  SetVariableGroups: mockSetVariableGroups,
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { GlobalConfigEditor } from "./GlobalConfigEditor";

const BASE_CONFIG = { OUTPUT_DIR: "D:/pages", LOGS_DIR: "D:/logs", USER: "me" };

beforeEach(async () => {
  mockGetGlobalConfig.mockReset().mockResolvedValue({ ...BASE_CONFIG });
  mockSetGlobalConfig.mockReset().mockResolvedValue(undefined);
  mockGetFragments.mockReset().mockResolvedValue([]);
  mockGetVarRefCounts.mockReset().mockResolvedValue({});
  mockGetVariableGroups.mockReset().mockResolvedValue([]);
  mockSetVariableGroups
    .mockReset()
    .mockImplementation((groups: VariableGroup[]) => Promise.resolve(groups));
  await i18n.changeLanguage("zh");
});

function renderView() {
  return render(
    <SidebarProvider>
      <ActionRunnerProvider>
        <GlobalConfigEditor />
      </ActionRunnerProvider>
    </SidebarProvider>,
  );
}

/** 等待分区（section[data-amb]）渲染——分区色是规格 E 的外部挂点。 */
async function findSection(container: HTMLElement, amb: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector<HTMLElement>(`section[data-amb="${amb}"]`);
    if (!el) throw new Error(`section[data-amb="${amb}"] 未渲染`);
    return el;
  });
}

describe("GlobalConfigEditor", () => {
  it("渲染已有全局配置行", async () => {
    renderView();
    expect(await screen.findByDisplayValue("OUTPUT_DIR")).toBeInTheDocument();
    expect(screen.getByDisplayValue("D:/pages")).toBeInTheDocument();
  });

  it("按 mock 分组数据渲染分区与 data-amb，未归组变量落在「未分组」", async () => {
    mockGetVariableGroups.mockResolvedValue([
      { name: "路径", color: "blue", keys: ["OUTPUT_DIR", "LOGS_DIR"] },
    ]);
    const { container } = renderView();
    const blue = await findSection(container, "blue");
    expect(within(blue).getByDisplayValue("OUTPUT_DIR")).toBeInTheDocument();
    expect(within(blue).getByDisplayValue("LOGS_DIR")).toBeInTheDocument();
    expect(within(blue).getByDisplayValue("D:/pages")).toBeInTheDocument();
    const none = await findSection(container, "none");
    expect(within(none).getByDisplayValue("USER")).toBeInTheDocument();
    // 分区头：名称按钮带展开态；副行是成员索引（未分组改读规则说明）
    expect(within(blue).getByRole("button", { name: /^路径/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(none).getByRole("button", { name: /^未分组/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(blue).getByText("OUTPUT_DIR · LOGS_DIR")).toBeInTheDocument();
    expect(within(none).getByText("尚未归类")).toBeInTheDocument();
    // 状态行：N 个变量 · G 组（G 不含「未分组」）
    expect(screen.getByText("3 个变量 · 1 组")).toBeInTheDocument();
    // 片段为空 → 不渲染「缺定义」
    expect(screen.queryByText("缺定义")).not.toBeInTheDocument();
  });

  it("新建分组：SetVariableGroups 收到追加的分组，默认取未占用色（回车提交）", async () => {
    const user = userEvent.setup();
    mockGetVariableGroups.mockResolvedValue([{ name: "路径", color: "blue", keys: ["OUTPUT_DIR"] }]);
    const { container } = renderView();
    await findSection(container, "blue");
    await user.click(screen.getByRole("button", { name: "新建分组" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("例如：路径"), "账号");
    await user.keyboard("{Enter}");
    // blue 已占用 → 色卡顺序取第一个未占用的 amber
    expect(mockSetVariableGroups).toHaveBeenCalledWith([
      { name: "路径", color: "blue", keys: ["OUTPUT_DIR"] },
      { name: "账号", color: "amber", keys: [] },
    ]);
    const amber = await findSection(container, "amber");
    expect(within(amber).getByRole("button", { name: /^账号/ })).toBeInTheDocument();
    // 空分组显示占位文案
    expect(within(amber).getByText("这组还没有变量")).toBeInTheDocument();
    expect(screen.getByText("3 个变量 · 2 组")).toBeInTheDocument();
  });

  it("新建分组对话框：空名 / 重名都拦截提交", async () => {
    const user = userEvent.setup();
    mockGetVariableGroups.mockResolvedValue([{ name: "路径", color: "blue", keys: ["OUTPUT_DIR"] }]);
    renderView();
    await screen.findByRole("button", { name: /^路径/ });
    await user.click(screen.getByRole("button", { name: "新建分组" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "新建分组" });
    // 空名不可提交
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByPlaceholderText("例如：路径"), "路径");
    expect(within(dialog).getByText("已有同名分组")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    expect(mockSetVariableGroups).not.toHaveBeenCalled();
  });

  it("重命名分组：同对话框预填名称，成员与颜色不变", async () => {
    const user = userEvent.setup();
    mockGetVariableGroups.mockResolvedValue([{ name: "路径", color: "blue", keys: ["OUTPUT_DIR"] }]);
    const { container } = renderView();
    await findSection(container, "blue");
    await user.click(screen.getByRole("button", { name: "重命名分组" }));
    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByPlaceholderText("例如：路径");
    expect(nameInput).toHaveValue("路径");
    await user.clear(nameInput);
    await user.type(nameInput, "目录");
    await user.click(within(dialog).getByRole("button", { name: "重命名分组" }));
    expect(mockSetVariableGroups).toHaveBeenCalledWith([
      { name: "目录", color: "blue", keys: ["OUTPUT_DIR"] },
    ]);
    await screen.findByRole("button", { name: /^目录/ });
  });

  it("改色：只有该分组的颜色变化", async () => {
    const user = userEvent.setup();
    mockGetVariableGroups.mockResolvedValue([
      { name: "路径", color: "blue", keys: ["OUTPUT_DIR"] },
      { name: "账号", color: "green", keys: [] },
    ]);
    const { container } = renderView();
    await findSection(container, "blue");
    await findSection(container, "green");
    await user.click(screen.getByRole("button", { name: "「路径」的卡片颜色" }));
    await user.click(await screen.findByRole("radio", { name: "紫色" }));
    expect(mockSetVariableGroups).toHaveBeenCalledTimes(1);
    expect(mockSetVariableGroups).toHaveBeenCalledWith([
      { name: "路径", color: "violet", keys: ["OUTPUT_DIR"] },
      { name: "账号", color: "green", keys: [] },
    ]);
    await findSection(container, "violet");
    await waitFor(() => expect(container.querySelector('section[data-amb="blue"]')).toBeNull());
    expect(container.querySelector('section[data-amb="green"]')).not.toBeNull();
  });

  it("移入分组：成员正确迁移，并丢弃页面与保存配置里都不存在的变量", async () => {
    const user = userEvent.setup();
    mockGetGlobalConfig.mockResolvedValue({ OUTPUT_DIR: "D:/pages", USER: "me" });
    mockGetVariableGroups.mockResolvedValue([
      { name: "路径", color: "blue", keys: ["OUTPUT_DIR", "STALE"] },
    ]);
    const { container } = renderView();
    const blue = await findSection(container, "blue");
    await user.click(screen.getByRole("combobox", { name: "移入分组：未分组" }));
    await user.click(await screen.findByRole("option", { name: "路径" }));
    // USER 追加进成员；STALE 既不在页面行里、也不在已保存配置里 → 载荷丢弃
    expect(mockSetVariableGroups).toHaveBeenCalledWith([
      { name: "路径", color: "blue", keys: ["OUTPUT_DIR", "USER"] },
    ]);
    await waitFor(() => expect(within(blue).getByDisplayValue("USER")).toBeInTheDocument());
    const none = container.querySelector<HTMLElement>('section[data-amb="none"]');
    expect(none).not.toBeNull();
    expect(within(none!).queryByDisplayValue("USER")).not.toBeInTheDocument();
  });

  it("删除分组：成员回到「未分组」", async () => {
    const user = userEvent.setup();
    mockGetVariableGroups.mockResolvedValue([{ name: "路径", color: "blue", keys: ["OUTPUT_DIR"] }]);
    const { container } = renderView();
    await findSection(container, "blue");
    await user.click(screen.getByRole("button", { name: "删除分组" }));
    expect(mockSetVariableGroups).toHaveBeenCalledWith([]);
    await waitFor(() => expect(container.querySelector('section[data-amb="blue"]')).toBeNull());
    const none = await findSection(container, "none");
    expect(within(none).getByDisplayValue("OUTPUT_DIR")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除分组" })).not.toBeInTheDocument();
  });

  it("分组写入失败：界面回滚并出现错误提示，下一次成功后清除", async () => {
    const user = userEvent.setup();
    mockGetVariableGroups.mockResolvedValue([{ name: "路径", color: "blue", keys: ["OUTPUT_DIR"] }]);
    const { container } = renderView();
    await findSection(container, "blue");
    mockSetVariableGroups.mockRejectedValueOnce(new Error("disk full"));
    await user.click(screen.getByRole("button", { name: "删除分组" }));
    // 回滚：分区还在，报错行出现
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("分组保存失败");
    expect(container.querySelector('section[data-amb="blue"]')).not.toBeNull();
    // 重试成功：错误清除、删除生效
    await user.click(screen.getByRole("button", { name: "删除分组" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await waitFor(() => expect(container.querySelector('section[data-amb="blue"]')).toBeNull());
  });

  it("改动后保存只调 SetGlobalConfig、不触发分组写入", async () => {
    const user = userEvent.setup();
    renderView();
    const valueInput = await screen.findByDisplayValue("D:/pages");
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();
    await user.type(valueInput, "x");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(mockSetGlobalConfig).toHaveBeenCalledWith({
      OUTPUT_DIR: "D:/pagesx",
      LOGS_DIR: "D:/logs",
      USER: "me",
    });
    expect(mockSetVariableGroups).not.toHaveBeenCalled();
  });

  it("显示变量被多少处引用（后端综合 actions + 片段）", async () => {
    mockGetVarRefCounts.mockResolvedValue({ OUTPUT_DIR: 3 });
    renderView();
    expect(await screen.findByText("3处")).toBeInTheDocument();
  });

  it("未被引用的变量标记为未用", async () => {
    renderView();
    // 多行同时未引用：至少一个「未用」标记出现即可
    expect((await screen.findAllByText("未用")).length).toBeGreaterThan(0);
  });

  it("重复键名给出红字提示", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByDisplayValue("OUTPUT_DIR");
    await user.click(screen.getByRole("button", { name: "新增" }));
    const keyInputs = screen.getAllByPlaceholderText("变量名");
    await user.type(keyInputs[keyInputs.length - 1], "OUTPUT_DIR");
    // 两行同键 → 都标「重复」，底部出现覆盖说明
    expect(screen.getAllByText("重复")).toHaveLength(2);
    expect(screen.getByText(/保存时后者将覆盖/)).toBeInTheDocument();
  });

  it("关系线：值引用了谁（派生自）、谁引用了它（引用它的变量）", async () => {
    mockGetGlobalConfig.mockResolvedValue({ DOCS: "D:/docs", OUTPUT_DIR: "${DOCS}/out" });
    renderView();
    await screen.findByDisplayValue("${DOCS}/out");
    expect(screen.getByText("派生自 DOCS")).toBeInTheDocument();
    expect(screen.getByText("引用它的变量 OUTPUT_DIR")).toBeInTheDocument();
  });

  it("缺定义只列片段引用的变量；补定义加一行且不触发任何写入", async () => {
    const user = userEvent.setup();
    mockGetGlobalConfig.mockResolvedValue({ OUTPUT_DIR: "D:/pages" });
    mockGetFragments.mockResolvedValue([
      { title: "a", content: "cat ${PATH} ${TEXT}", tags: [] },
      { title: "b", content: "echo ${PATH}", tags: [] },
      { title: "c", content: "date ${CURRENT_DATE} ${OUTPUT_DIR}", tags: [] },
    ]);
    renderView();
    expect(await screen.findByText("缺定义")).toBeInTheDocument();
    // 只列片段引用且未定义的：PATH、TEXT（内置变量与已定义的排除）
    expect(screen.getByText("${PATH}")).toBeInTheDocument();
    expect(screen.getByText("${TEXT}")).toBeInTheDocument();
    expect(screen.queryByText("${CURRENT_DATE}")).not.toBeInTheDocument();
    expect(screen.queryByText("${OUTPUT_DIR}")).not.toBeInTheDocument();
    // 按引用片段数降序：PATH(2) 在 TEXT(1) 前
    expect(screen.getByText("引用 2 处")).toBeInTheDocument();
    expect(screen.getByText("引用 1 处")).toBeInTheDocument();
    const path = screen.getByText("${PATH}");
    const text = screen.getByText("${TEXT}");
    expect(path.compareDocumentPosition(text)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // 补定义：加一行（名称预填、落「未分组」）、焦点给值输入框、无任何写入
    const defineBtns = screen.getAllByRole("button", { name: "补定义" });
    await user.click(defineBtns[0]);
    const keyInput = await screen.findByDisplayValue("PATH");
    expect(keyInput).toBeInTheDocument();
    const none = document.querySelector<HTMLElement>('section[data-amb="none"]');
    expect(none).not.toBeNull();
    expect(none!).toContainElement(keyInput);
    expect(screen.getAllByPlaceholderText("值")).toContain(document.activeElement);
    expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled();
    expect(mockSetGlobalConfig).not.toHaveBeenCalled();
    expect(mockSetVariableGroups).not.toHaveBeenCalled();
  });

  it("分组加载是页面级 hook：GetVariableGroups 只调一次、Provider 启动加载不变", async () => {
    renderView();
    expect(await screen.findByDisplayValue("OUTPUT_DIR")).toBeInTheDocument();
    expect(mockGetVariableGroups).toHaveBeenCalledTimes(1);
    expect(mockGetGlobalConfig).toHaveBeenCalledTimes(1);
  });

  it("没有任何变量也没有分组时沿用空状态", async () => {
    mockGetGlobalConfig.mockResolvedValue({});
    const { container } = renderView();
    expect(await screen.findByText("（暂无变量，点「新增」添加）")).toBeInTheDocument();
    expect(container.querySelector("section")).toBeNull();
  });

  it("i18n 中英两份 key 一一对应", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
});
