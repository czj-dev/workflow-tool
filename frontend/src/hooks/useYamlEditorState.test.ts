import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useYamlEditorState,
  type YamlEditorItem,
} from "./useYamlEditorState";

const ITEMS: YamlEditorItem[] = [
  { id: "a", title: "动作A" },
  { id: "b", title: "动作B" },
];

function setup(overrides: Partial<Parameters<typeof useYamlEditorState>[0]> = {}) {
  const getYaml = vi.fn(async (id: string) => `id: ${id}\ntitle: ${id.toUpperCase()}\n`);
  const saveYaml = vi.fn(async () => undefined);
  const initialProps = {
    items: ITEMS,
    currentId: null as string | null,
    getYaml,
    saveYaml,
    savedNotice: "saved",
    ...overrides,
  };
  return { ...renderHook(useYamlEditorState, { initialProps }), getYaml, saveYaml, initialProps };
}

describe("useYamlEditorState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("items 到达后初始化 editingId 为首个并加载其 yaml", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.text).toContain("title: A"));
    expect(result.current.editingId).toBe("a");
    expect(result.current.loading).toBe(false);
  });

  it("currentId 优先于首个 item 作为初始 editingId", async () => {
    const { result } = setup({ currentId: "b" });
    await waitFor(() => expect(result.current.text).toContain("title: B"));
    expect(result.current.editingId).toBe("b");
  });

  it("编辑后标 dirty，保存写盘并清 dirty、置 notice", async () => {
    const { result, saveYaml } = setup();
    await waitFor(() => expect(result.current.text).toContain("title: A"));
    act(() => result.current.setText("id: a\n"));
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    expect(saveYaml).toHaveBeenCalledWith("a", "id: a\n");
    expect(result.current.dirty).toBe(false);
    expect(result.current.notice).toBe("saved");
  });

  it("保存失败置 error 且保留 dirty", async () => {
    const { result, saveYaml } = setup();
    await waitFor(() => expect(result.current.text).toContain("title: A"));
    act(() => result.current.setText("id: a\n"));
    saveYaml.mockRejectedValueOnce("YAML 解析失败: line 1");
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.error).toBe("YAML 解析失败: line 1");
    expect(result.current.dirty).toBe(true);
  });

  it("切换 editingId 后加载新 yaml", async () => {
    const { result, getYaml } = setup();
    await waitFor(() => expect(getYaml).toHaveBeenCalledWith("a"));
    act(() => result.current.setEditingId("b"));
    await waitFor(() => expect(getYaml).toHaveBeenCalledWith("b"));
    await waitFor(() => expect(result.current.text).toContain("title: B"));
  });

  it("reset 重新拉取原文并清 dirty", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.text).toContain("title: A"));
    act(() => result.current.setText("dirty change\n"));
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      await result.current.reset();
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.text).toContain("title: A");
  });

  it("Provider 重渲染产生新 getYaml 引用不触发重新拉取（不覆盖编辑）", async () => {
    const { result, rerender, getYaml } = setup();
    await waitFor(() => expect(result.current.text).toContain("title: A"));
    act(() => result.current.setText("edited\n"));
    const edited = result.current.text;
    // 用全新的 getYaml 引用重渲染（模拟 Provider 每渲染新闭包）
    const getYaml2 = vi.fn(async (id: string) => `id: ${id}\n`);
    rerender({
      items: ITEMS,
      currentId: null,
      getYaml: getYaml2,
      saveYaml: vi.fn(async () => undefined),
      savedNotice: "saved",
    });
    expect(getYaml2).not.toHaveBeenCalled();
    expect(getYaml).toHaveBeenCalledTimes(1);
    expect(result.current.text).toBe(edited);
    expect(result.current.dirty).toBe(true);
  });

  it("前端实时校验：非法 YAML 置 parseError，合法则 null", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.text).toContain("title: A"));
    expect(result.current.parseError).toBeNull();
    act(() => result.current.setText("key: [a, b\n")); // 未闭合 flow sequence，必为解析错误
    expect(result.current.parseError).not.toBeNull();
    act(() => result.current.setText("key: value\n"));
    expect(result.current.parseError).toBeNull();
  });
});
