import { describe, expect, it } from "vitest";
import {
  flattenTree,
  parseTreeFrame,
  searchTree,
  treeFrameToText,
  type TreeNode,
} from "./treeFrame";

// 两层嵌套测试树：root(dir) → [a.txt(file), sub(dir) → [b.txt(file)]]
const nodes: TreeNode[] = [
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

describe("parseTreeFrame", () => {
  it("解析合法 JSON：title 透传、nodes 原样", () => {
    const raw = JSON.stringify({ title: "T · 共 1 个条目", nodes: [{ label: "a" }] });
    expect(parseTreeFrame(raw, "err")).toEqual({
      title: "T · 共 1 个条目",
      nodes: [{ label: "a" }],
    });
  });

  it("nodes 非数组时降级（防脏数据不炸）", () => {
    const f = parseTreeFrame(JSON.stringify({ nodes: "oops" }), "err");
    expect(f.nodes).toHaveLength(1);
    expect(f.nodes[0].label).toBe("err");
  });

  it("非法 JSON 降级为单错误节点，detail 带原文片段", () => {
    const f = parseTreeFrame("not-json", "解析失败");
    expect(f.nodes).toEqual([{ label: "解析失败", detail: "not-json" }]);
    expect(f.title).toBeUndefined();
  });

  it("超长原文截断到 120 字符 + 省略号；空原文显示 (empty)", () => {
    const long = "x".repeat(200);
    expect(parseTreeFrame(long, "e").nodes[0].detail).toBe("x".repeat(120) + "…");
    expect(parseTreeFrame("", "e").nodes[0].detail).toBe("(empty)");
  });
});

describe("flattenTree", () => {
  it("深度优先拍平：key 是索引路径、depth 根为 0、parentKey 成链", () => {
    const flat = flattenTree(nodes);
    expect(flat.map((f) => f.node.label)).toEqual(["root.zip", "a.txt", "sub", "b.txt"]);
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 1, 2]);
    expect(flat.map((f) => f.key)).toEqual(["0", "0/0", "0/1", "0/1/0"]);
    expect(flat.map((f) => f.parentKey)).toEqual([null, "0", "0", "0/1"]);
  });

  it("连接线：根为空、末位子 └─ 、非末位 ├─ 、祖先竖线随 trail", () => {
    const flat = flattenTree(nodes);
    expect(flat[0].rail).toBe("");
    // depth-1 行也有一个 trail 段（根无后续兄弟 → 空格段）：a.txt 非末位子 → ├─
    expect(flat[1].rail).toBe("   ├─ ");
    // sub 是末位子 → └─
    expect(flat[2].rail).toBe("   └─ ");
    // b.txt：两段 trail 全空 + └─
    expect(flat[3].rail).toBe("      └─ ");
  });

  it("trail 保留竖线：中间目录下仍有后续兄弟时 │  前缀", () => {
    const tree: TreeNode[] = [
      {
        label: "r",
        children: [
          { label: "m", children: [{ label: "x" }] },
          { label: "tail" },
        ],
      },
    ];
    const flat = flattenTree(tree);
    // m 非末位子（后还有 tail）→ m 的孩子 x 的第二段 trail 画 │：空段 + │段 + └─
    expect(flat.find((f) => f.node.label === "x")!.rail).toBe("   │  └─ ");
    // tail 是末位子
    expect(flat.find((f) => f.node.label === "tail")!.rail).toBe("   └─ ");
  });

  it("copyText：path 优先，否则根到叶 label 面包屑 / 连接", () => {
    const flat = flattenTree(nodes);
    const a = flat.find((f) => f.node.label === "a.txt")!;
    expect(a.copyText).toBe("root.zip/a.txt"); // path
    const b = flat.find((f) => f.node.label === "b.txt")!;
    expect(b.copyText).toBe("root.zip/sub/b.txt"); // 面包屑兜底
  });
});

describe("searchTree", () => {
  it("空查询返回 null（非搜索态）", () => {
    expect(searchTree(flattenTree(nodes), "")).toBeNull();
    expect(searchTree(flattenTree(nodes), "   ")).toBeNull();
  });

  it("label 命中（大小写不敏感）保留命中 + 全部祖先，其余隐藏", () => {
    const s = searchTree(flattenTree(nodes), "B.TXT")!;
    expect([...s.keep].sort()).toEqual(["0", "0/1", "0/1/0"]);
    expect(s.labelHit.has("0/1/0")).toBe(true);
    expect(s.dim.size).toBe(0); // label 命中不算 dim
  });

  it("仅 detail 命中：保留 + 祖先，但进 dim 降透明、不进 labelHit", () => {
    const s = searchTree(flattenTree(nodes), "1.0 KB")!;
    expect([...s.keep].sort()).toEqual(["0", "0/1", "0/1/0"]);
    expect(s.dim.has("0/1/0")).toBe(true);
    expect(s.labelHit.size).toBe(0);
  });

  it("无命中返回空 keep 集", () => {
    const s = searchTree(flattenTree(nodes), "zzz")!;
    expect(s.keep.size).toBe(0);
    expect(s.dim.size).toBe(0);
  });
});

describe("treeFrameToText", () => {
  it("title 首行 + 连接线行（label + 两空格 detail），整段复制用", () => {
    const text = treeFrameToText({ title: "root.zip · 共 3 个条目", nodes });
    const lines = text.split("\n");
    expect(lines[0]).toBe("root.zip · 共 3 个条目");
    expect(lines[1]).toBe("root.zip");
    expect(lines[2]).toBe("   ├─ a.txt  12 B");
    expect(lines[3]).toBe("   └─ sub");
    expect(lines[4]).toBe("      └─ b.txt  1.0 KB");
  });

  it("无 title 时直接以节点行开头", () => {
    const lines = treeFrameToText({ nodes }).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("root.zip");
  });
});
