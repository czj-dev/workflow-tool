import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TreeBlock } from "./TreeBlock";
import type { TreeFrame, TreeNode } from "../lib/treeFrame";

// zip 浏览树：root(dir) → [a.txt(file·有 path), sub(dir) → b.txt(file·有 detail 无 path)]
const zipNodes: TreeNode[] = [
  {
    label: "root.zip",
    kind: "dir",
    children: [
      { label: "a.txt", kind: "file", detail: "12 B", path: "root.zip/a.txt" },
      {
        label: "sub",
        kind: "dir",
        children: [{ label: "b.txt", kind: "file", detail: "1.0 KB" }],
      },
    ],
  },
];

// 四层树：默认展开 2 层（depth<2），depth≥3 折叠
const deepNodes: TreeNode[] = [
  {
    label: "r",
    children: [
      { label: "c", children: [{ label: "g", children: [{ label: "leaf4" }] }] },
    ],
  },
];

const writeText = vi.fn().mockResolvedValue(undefined);

// jsdom 无 navigator.clipboard：注入 mock（writeText resolve 即不走 execCommand 兜底）。
// 注意 userEvent.setup() 会接管 navigator.clipboard，setup 之后必须重打桩（同 FragmentsSheet.test）。
const stubClipboard = () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
};

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  stubClipboard();
});

// 行元素：label 文本 → 最近的 .tree-row（行点击/类名断言用）
const rowOf = (text: string) => screen.getByText(text).closest(".tree-row")!;

describe("TreeBlock", () => {
  it("渲染标题与徽标 kind 原样；label==kind 时标签去重", () => {
    const frame: TreeFrame = {
      title: "window_tree",
      nodes: [
        {
          label: "FrameLayout",
          kind: "FrameLayout",
          children: [{ label: "TextView", kind: "TextView", detail: "360×640" }],
        },
      ],
    };
    render(<TreeBlock frame={frame} />);
    expect(screen.getByText("window_tree")).toBeInTheDocument();
    // label==kind：只渲染徽标一次，标签不重复
    expect(screen.getAllByText("FrameLayout")).toHaveLength(1);
    expect(screen.getAllByText("TextView")).toHaveLength(1);
    expect(screen.getByText("360×640")).toBeInTheDocument();
  });

  it("属性面板默认折叠，展开后显示通用键值且不触发树行操作", async () => {
    const user = userEvent.setup();
    render(
      <TreeBlock
        frame={{
          nodes: [
            {
              label: "Button",
              kind: "Button",
              properties: { enabled: false, text: "登录", bounds: { left: 1, top: 2 } },
              children: [{ label: "child" }],
            },
          ],
        }}
      />,
    );
    expect(screen.queryByText("enabled", { exact: true })).toBeNull();
    await user.click(screen.getByRole("button", { name: "属性" }));
    expect(screen.getByText("enabled", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("false", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("left", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("1", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("child")).toBeInTheDocument();
    expect(screen.getByText("属性").closest(".tree-properties-layout")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")[0]).toHaveAttribute("aria-expanded", "true");
  });

  it("View 树默认显示深层控件，并允许折叠其祖先", async () => {
    const user = userEvent.setup();
    const viewNodes: TreeNode[] = [{
      label: "root",
      properties: { class: "FrameLayout" },
      children: [{ label: "container", children: [{ label: "wrapper", children: [{ label: "button", properties: { clickable: true } }] }] }],
    }];
    render(<TreeBlock frame={{ nodes: viewNodes, defaultExpandAll: true }} />);
    expect(screen.getByText("button")).toBeInTheDocument();
    const buttonTreeItem = screen.getByText("button").closest('[role="treeitem"]');
    const buttonTreeRail = buttonTreeItem?.querySelector(".tree-rail");
    const buttonPropertiesRail = buttonTreeItem?.querySelector(".tree-properties-rail");
    expect(buttonPropertiesRail?.textContent).toBe(buttonTreeRail?.textContent);
    expect(buttonTreeItem?.querySelector(".tree-properties-layout")).toBeInTheDocument();
    await user.click(screen.getByText("container"));
    expect(screen.queryByText("button")).toBeNull();
  });

  it("带属性的普通树仍默认只展开两层", () => {
    render(<TreeBlock frame={{ nodes: [{ ...deepNodes[0], properties: { size: 10 } }] }} />);
    expect(screen.getByText("g")).toBeInTheDocument();
    expect(screen.queryByText("leaf4")).toBeNull();
  });

  it("默认展开两层；折叠/展开按钮切换深度", async () => {
    const user = userEvent.setup();
    render(<TreeBlock frame={{ nodes: deepNodes }} />);
    // depth 0-2 可见（r/c/g），depth 3（leaf4）默认折叠
    expect(screen.getByText("g")).toBeInTheDocument();
    expect(screen.queryByText("leaf4")).toBeNull();
    await user.click(screen.getByRole("button", { name: "展开" }));
    expect(screen.getByText("leaf4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "折叠" }));
    // 折叠到 depth 1：根与直接子级行可见，孙级起隐藏
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("g")).toBeNull();
  });

  it("点击非叶子行折叠/再展开该子树（单点覆盖）", async () => {
    const user = userEvent.setup();
    render(<TreeBlock frame={{ nodes: zipNodes }} />);
    expect(screen.getByText("b.txt")).toBeInTheDocument();
    await user.click(screen.getByText("sub"));
    expect(screen.queryByText("b.txt")).toBeNull();
    await user.click(screen.getByText("sub"));
    expect(screen.getByText("b.txt")).toBeInTheDocument();
  });

  it("搜索：命中 label 保留+祖先并高亮 mark；仅 detail 命中的行降透明", async () => {
    const user = userEvent.setup();
    render(<TreeBlock frame={{ nodes: zipNodes }} />);
    const input = screen.getByPlaceholderText("搜索 标签/详情…");
    await user.type(input, "b.txt");
    // 命中行 + 祖先保留，未命中兄弟隐藏
    expect(screen.queryByText("a.txt")).toBeNull();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
    expect(screen.getByText("sub")).toBeInTheDocument();
    // label 命中处包 <mark class="tree-mark">
    expect(document.querySelector(".tree-mark")?.textContent).toBe("b.txt");
    // 清空恢复默认深度与全量行
    await user.clear(input);
    expect(screen.getByText("a.txt")).toBeInTheDocument();

    // 仅 detail 命中：行保留但带 dimmed
    await user.type(input, "1.0 KB");
    expect(rowOf("b.txt")).toHaveClass("dimmed");
    expect(screen.queryByText("a.txt")).toBeNull();
  });

  it("叶子点击复制完整路径（path 优先）并弹 toast", async () => {
    const user = userEvent.setup();
    stubClipboard(); // setup 接管了 clipboard，重打回桩
    render(<TreeBlock frame={{ nodes: zipNodes }} />);
    await user.click(screen.getByText("a.txt"));
    expect(writeText).toHaveBeenCalledWith("root.zip/a.txt");
    expect(await screen.findByRole("status")).toHaveTextContent("已复制 root.zip/a.txt");
  });

  it("配置点击事件时执行回调而不复制，目录仍只折叠", async () => {
    const user = userEvent.setup();
    stubClipboard();
    const onLeafClick = vi.fn().mockResolvedValue(undefined);
    render(<TreeBlock frame={{ nodes: zipNodes }} onLeafClick={onLeafClick} />);
    await user.click(screen.getByText("sub"));
    expect(onLeafClick).not.toHaveBeenCalled();
    await user.click(screen.getByText("a.txt"));
    expect(onLeafClick).toHaveBeenCalledWith(zipNodes[0].children![0]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("带空 children 的文件仍按叶子点击", async () => {
    const onLeafClick = vi.fn().mockResolvedValue(undefined);
    const file = { label: "a.log", kind: "file", path: "a.log", children: [] };
    render(<TreeBlock frame={{ nodes: [file] }} onLeafClick={onLeafClick} />);
    await userEvent.click(screen.getByText("a.log"));
    expect(onLeafClick).toHaveBeenCalledWith(file);
  });

  it("空目录点击不触发叶子动作", async () => {
    const onLeafClick = vi.fn().mockResolvedValue(undefined);
    render(<TreeBlock frame={{ nodes: [{ label: "empty", kind: "dir", children: [] }] }} onLeafClick={onLeafClick} />);
    await userEvent.click(screen.getByText("empty"));
    expect(onLeafClick).not.toHaveBeenCalled();
  });

  it("面包屑兜底：无 path 的叶子复制根到叶 label 路径", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(<TreeBlock frame={{ nodes: zipNodes }} />);
    await user.click(screen.getByText("b.txt"));
    expect(writeText).toHaveBeenCalledWith("root.zip/sub/b.txt");
  });

  it("解析失败帧（单错误节点）原样渲染 detail 原文片段", () => {
    render(
      <TreeBlock
        frame={{ nodes: [{ label: "树帧解析失败", detail: "not-json{{{" }] }}
      />,
    );
    expect(screen.getByText("树帧解析失败")).toBeInTheDocument();
    expect(screen.getByText("not-json{{{")).toBeInTheDocument();
  });
});
