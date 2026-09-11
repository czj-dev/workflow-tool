// ##[tree] 树帧的前端类型与纯函数：解析、拍平（含 │├└ 连接线）、搜索过滤、
// 缩进文本化。schema 与 Go internal/adb/tree.go 对齐（label 必填，kind/detail/
// path/children 可选）；渲染组件 TreeBlock 只做展示与交互，逻辑全在这层以便单测。

export interface TreeNode {
  label: string;
  // 类型徽标：原样渲染，前端无 kind→文案/颜色映射（文件树 dir/file，View 树=class 短名）
  kind?: string;
  // 弱化补充（大小/属性/截断说明），搜索时与 label 一起参与匹配
  detail?: string;
  // 叶子点击复制的完整路径；空则前端回退根到叶 label 面包屑（/ 连接）
  path?: string;
  children?: TreeNode[];
}

export interface TreeFrame {
  title?: string;
  nodes: TreeNode[];
}

// parseTreeFrame 把树 JSON 原文解析成帧；失败不炸——降级为单错误节点帧
// （label 由调用方传入，i18n 归组件层），detail 带原文片段便于排查。
export function parseTreeFrame(raw: string, errLabel: string): TreeFrame {
  try {
    const v = JSON.parse(raw) as { title?: unknown; nodes?: unknown };
    if (v && Array.isArray(v.nodes)) {
      return { title: typeof v.title === "string" ? v.title : undefined, nodes: v.nodes as TreeNode[] };
    }
  } catch {
    // 落到下方统一降级
  }
  return {
    nodes: [
      {
        label: errLabel,
        detail: raw.length > 120 ? raw.slice(0, 120) + "…" : raw || "(empty)",
      },
    ],
  };
}

// FlatNode 是拍平后的渲染行：连接线/深度/父链/复制文本都预算好，TreeBlock 只做分派。
export interface FlatNode {
  // 稳定 key：根到本节点的索引路径（帧不可变，key 跨渲染稳定）
  key: string;
  // 父节点 key（根为 null）——折叠时沿链上溯判断可见性
  parentKey: string | null;
  node: TreeNode;
  depth: number; // 根=0；默认展开 2 层即 depth<2 的节点可见其子
  // 行首连接线：祖先「还有后续兄弟？」× 层级 + 肘形（├─/└─）；根为 ""
  rail: string;
  // 根到本节点的 label 面包屑（复制兜底用）
  labelPath: string[];
  // 叶子点击复制文本：path 优先，否则面包屑 / 连接
  copyText: string;
}

// railFor 生成连接线（与旧 Go formatTree 同构）：祖先竖线 + 肘形。
// trail[i] = 第 i 层祖先之后是否还有兄弟（│/空），isLast = 本节点是否末位子（└/├）。
function railFor(trail: boolean[], isLast: boolean): string {
  let s = "";
  for (const hasNext of trail) s += hasNext ? "│  " : "   ";
  return s + (isLast ? "└─ " : "├─ ");
}

// flattenTree 深度优先拍平整棵树（≤5000 节点护栏在数据源，前端不再限量）。
export function flattenTree(nodes: TreeNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (list: TreeNode[], trail: boolean[], parentKey: string | null, labels: string[]) => {
    list.forEach((node, i) => {
      const isLast = i === list.length - 1;
      const key = parentKey === null ? `${i}` : `${parentKey}/${i}`;
      const labelPath = [...labels, node.label ?? ""];
      out.push({
        key,
        parentKey,
        node,
        depth: trail.length,
        rail: trail.length === 0 ? "" : railFor(trail, isLast),
        labelPath,
        copyText: node.path || labelPath.join("/"),
      });
      if (node.children?.length) {
        walk(node.children, [...trail, !isLast], key, labelPath);
      }
    });
  };
  walk(nodes ?? [], [], null, []);
  return out;
}

// TreeSearch 是块内搜索的预计算结果：keep=命中+祖先（其余隐藏），
// dim=仅 detail 命中而 label 未命中（降透明），labelHit=label 命中（<mark> 高亮）。
export interface TreeSearch {
  keep: Set<string>;
  dim: Set<string>;
  labelHit: Set<string>;
}

// searchTree 按 q（大小写不敏感子串）匹配 label 或 detail；q 空返回 null（非搜索态）。
export function searchTree(flat: FlatNode[], q: string): TreeSearch | null {
  const query = q.trim();
  if (!query) return null;
  const ql = query.toLowerCase();
  const byKey = new Map(flat.map((f) => [f.key, f]));
  const keep = new Set<string>();
  const dim = new Set<string>();
  const labelHit = new Set<string>();
  for (const f of flat) {
    const label = (f.node.label ?? "").toLowerCase();
    const detail = (f.node.detail ?? "").toLowerCase();
    const hitLabel = label.includes(ql);
    if (!hitLabel && !detail.includes(ql)) continue;
    keep.add(f.key);
    if (hitLabel) labelHit.add(f.key);
    else dim.add(f.key); // 仅 detail 命中：保留但降透明
    let cur = f.parentKey === null ? undefined : byKey.get(f.parentKey);
    while (cur) {
      keep.add(cur.key);
      cur = cur.parentKey === null ? undefined : byKey.get(cur.parentKey);
    }
  }
  return { keep, dim, labelHit };
}

// treeFrameToText 把帧转成展开缩进文本（copyOutput 整段复制时的树块形态）：
// title 首行 + 连接线行（label + 弱化 detail）。
export function treeFrameToText(frame: TreeFrame): string {
  const flat = flattenTree(frame.nodes ?? []);
  const lines: string[] = [];
  if (frame.title) lines.push(frame.title);
  for (const f of flat) {
    const detail = f.node.detail ? `  ${f.node.detail}` : "";
    lines.push(`${f.rail}${f.node.label ?? ""}${detail}`);
  }
  return lines.join("\n");
}
