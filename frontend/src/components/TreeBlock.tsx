import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { flattenTree, searchTree, type FlatNode, type TreeFrame, type TreeNode } from "../lib/treeFrame";
import { TreePropertiesPanel } from "./TreePropertiesPanel";

// ##[tree] 内联树块（mockup v2.4 定稿视觉，样式见 index.css 的 .treeblock 一节）：
// - 徽标 = 节点 kind 原样渲染，无 kind→文案/颜色映射；label==kind 时不重复显示标签
// - 配色只按结构：容器=主题色、叶子=灰，全走主题 token 亮暗自适应
// - 等宽 │├└ 连接线（与旧 formatTree 同构）；默认展开 2 层（根=0），帧可指定全部展开
// - 块内搜索：命中 label 或 detail；命中+祖先保留，仅 detail 命中的节点降透明，其余隐藏
// - 叶子点击复制完整路径（path 优先，否则根到叶 label 面包屑）+ toast；非叶子点击=折叠
// 逻辑纯函数在 lib/treeFrame.ts，样式在 index.css 的 .treeblock 一节。

// 默认展开深度：depth < DEFAULT_DEPTH 的节点不折叠（根=0 → 根+直接子级可见）。
const DEFAULT_DEPTH = 2;

interface TreeBlockProps {
  frame: TreeFrame;
  onLeafClick?: (node: TreeNode) => Promise<void>;
  // 勾选模式（对应源 action 声明的 hmi.tree.click.multi）：行首 checkbox，
  // 目录勾选=后代叶子全选；行点击行为不变（叶子照旧触发 onLeafClick）
  multi?: boolean;
  // 批量按钮回调：入参为选中叶子集合（DFS 树序）；空选时按钮禁用
  onSelectionSubmit?: (nodes: TreeNode[]) => Promise<void>;
}

// copyText 剪贴板写入：clipboard API 优先（Wails 安全上下文可用），
// 被拒（如 jsdom / 权限收窄）时退回 execCommand，两者都失败不炸。
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    // 落到 fallback
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// 行首勾选框：indeterminate 只能经 DOM property 设置（React 不认该 attribute）
function TreeCheck(props: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.indeterminate;
  }, [props.indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="tree-check"
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props.label}
      onChange={props.onChange}
      onClick={(e) => e.stopPropagation()} // 勾选不得触发行点击（叶子下载/目录折叠）
    />
  );
}

// 是否叶子行与行点击分派同口径：kind 非 dir 且无子节点
const isLeafNode = (f: FlatNode) => f.node.kind !== "dir" && !f.node.children?.length;

export function TreeBlock({ frame, onLeafClick, multi, onSelectionSubmit }: TreeBlockProps) {
  const { t } = useTranslation();
  const flat = useMemo(() => flattenTree(frame.nodes ?? []), [frame]);
  const defaultDepth = frame.defaultExpandAll ? Infinity : DEFAULT_DEPTH;
  const [query, setQuery] = useState("");
  const [depthLimit, setDepthLimit] = useState(defaultDepth);
  // 单节点折叠覆盖（key→是否折叠）；「折叠/展开」按钮改 depthLimit 并清覆盖
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useMemo(() => searchTree(flat, query), [flat, query]);

  // 勾选集合只存叶子 key（目录勾选=后代叶子全选）；搜索/折叠不影响勾选集
  const selectMode = !!multi && !!onSelectionSubmit;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const descendantLeafKeys = (key: string) =>
    flat.filter((f) => isLeafNode(f) && f.key.startsWith(key + "/")).map((f) => f.key);
  const toggleLeaf = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleDirLeaves = (leaves: string[], allOn: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      leaves.forEach((k) => (allOn ? next.delete(k) : next.add(k)));
      return next;
    });
  const submitSelection = async () => {
    // DFS 树序回传选中叶子，后端按行 join；失败复用块内 toast 提示
    const nodes = flat.filter((f) => selected.has(f.key) && isLeafNode(f)).map((f) => f.node);
    try {
      await onSelectionSubmit?.(nodes);
    } catch (error) {
      showToast(String(error));
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // 节点自身是否折叠：搜索态强制全展开（keep 集决定可见性）；否则覆盖优先、
  // 缺省按 depthLimit（depth ≥ limit 即折叠，与 mockup setDepth 同语义）。
  const isCollapsed = (f: FlatNode): boolean => {
    if (search) return false;
    return overrides.get(f.key) ?? f.depth >= depthLimit;
  };

  // 非搜索态可见 = 祖先全部未折叠；搜索态可见 = 在 keep 集内。
  const byKey = useMemo(() => new Map(flat.map((f) => [f.key, f])), [flat]);
  const visibleKeys = useMemo(() => {
    const vis = new Set<string>();
    for (const f of flat) {
      if (search) {
        if (search.keep.has(f.key)) vis.add(f.key);
        continue;
      }
      let ok = true;
      let cur: FlatNode | undefined = f;
      while (cur && ok) {
        const parent: FlatNode | undefined =
          cur.parentKey === null ? undefined : byKey.get(cur.parentKey);
        if (parent && isCollapsed(parent)) ok = false;
        cur = parent;
      }
      if (ok) vis.add(f.key);
    }
    return vis;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, byKey, search, depthLimit, overrides]);

  const onQueryChange = (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      // 清空搜索后恢复当前树帧的初始展开深度。
      setDepthLimit(defaultDepth);
      setOverrides(new Map());
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  const onRowClick = async (f: FlatNode) => {
    if (f.node.kind === "dir" || (f.node.children?.length ?? 0) > 0) {
      // 非叶子：切换自身折叠
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(f.key, !(prev.get(f.key) ?? f.depth >= depthLimit));
        return next;
      });
      return;
    }
    if (onLeafClick) {
      try {
        await onLeafClick(f.node);
      } catch (error) {
        showToast(String(error));
      }
      return;
    }
    // 叶子：复制完整路径（path 优先，面包屑兜底）
    if (await writeClipboard(f.copyText)) {
      showToast(t("tree.copied", { path: f.copyText }));
    }
  };

  // label 命中高亮：首个大小写不敏感命中处包 <mark>（detail 不高亮，同 mockup）
  const renderLabel = (f: FlatNode) => {
    const label = f.node.label ?? "";
    if (!search?.labelHit.has(f.key)) return label;
    const i = label.toLowerCase().indexOf(query.trim().toLowerCase());
    if (i < 0) return label;
    return (
      <>
        {label.slice(0, i)}
        <mark className="tree-mark">{label.slice(i, i + query.trim().length)}</mark>
        {label.slice(i + query.trim().length)}
      </>
    );
  };

  return (
    <div className="treeblock">
      <div className="treeblock-head">
        <span className="treeblock-title" title={frame.title}>
          {frame.title}
        </span>
        <input
          className="treeblock-search"
          type="text"
          value={query}
          placeholder={t("tree.searchPlaceholder")}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <button
          type="button"
          className="tree-mini-btn"
          onClick={() => {
            setDepthLimit(1);
            setOverrides(new Map());
          }}
        >
          {t("tree.collapse")}
        </button>
        <button
          type="button"
          className="tree-mini-btn"
          onClick={() => {
            setDepthLimit(Infinity);
            setOverrides(new Map());
          }}
        >
          {t("tree.expand")}
        </button>
      </div>
      <div className="treeblock-body" role="tree">
        {flat.map((f) => {
          if (!visibleKeys.has(f.key)) return null;
          const isLeaf = isLeafNode(f);
          const dimmed = search?.dim.has(f.key);
          const showLabel = (f.node.label ?? "") !== "" && f.node.label !== f.node.kind;
          // 目录勾选态：后代叶子全选=选中，部分=半选；空目录禁用
          const dirLeaves = selectMode && !isLeaf ? descendantLeafKeys(f.key) : [];
          const dirAll = dirLeaves.length > 0 && dirLeaves.every((k) => selected.has(k));
          const dirSome = !dirAll && dirLeaves.some((k) => selected.has(k));
          return (
            <div key={f.key} role="treeitem" aria-expanded={isLeaf ? undefined : !isCollapsed(f)}>
              <span
                className={cn("tree-row", isLeaf ? "leaf" : "branch", dimmed && "dimmed")}
                role="button"
                tabIndex={0}
                title={isLeaf && !onLeafClick ? t("tree.copyHint", { path: f.copyText }) : undefined}
                onClick={() => void onRowClick(f)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void onRowClick(f);
                  }
                }}
              >
                {selectMode &&
                  (isLeaf ? (
                    <TreeCheck
                      checked={selected.has(f.key)}
                      label={t("tree.selectNode", { label: f.node.label ?? f.key })}
                      onChange={() => toggleLeaf(f.key)}
                    />
                  ) : (
                    <TreeCheck
                      checked={dirAll}
                      indeterminate={dirSome}
                      disabled={dirLeaves.length === 0}
                      label={t("tree.selectNode", { label: f.node.label ?? f.key })}
                      onChange={() => toggleDirLeaves(dirLeaves, dirAll)}
                    />
                  ))}
                <span className="tree-rail" aria-hidden="true">
                  {f.rail}
                </span>
                <span className="tree-caret" aria-hidden="true">
                  {isLeaf ? "" : isCollapsed(f) ? "▸" : "▾"}
                </span>
                {f.node.kind && <span className="tree-badge">{f.node.kind}</span>}
                {showLabel && <span className="tree-label">{renderLabel(f)}</span>}
                {f.node.detail && <span className="tree-detail">{f.node.detail}</span>}
              </span>
              {f.node.properties && (
                <TreePropertiesPanel
                  properties={f.node.properties}
                  rail={f.rail}
                  kind={f.node.kind}
                />
              )}
            </div>
          );
        })}
      </div>
      {/* 勾选模式底栏：计数 + 批量按钮（空选禁用）；行点击行为不受影响 */}
      {selectMode && (
        <div className="treeblock-foot">
          <span className="tree-select-count">{t("tree.selectedCount", { count: selected.size })}</span>
          <button
            type="button"
            className="tree-batch-btn"
            disabled={selected.size === 0}
            onClick={() => void submitSelection()}
          >
            {t("tree.downloadSelected", { count: selected.size })}
          </button>
        </div>
      )}
      {/* 复制反馈 toast：fixed 定位挂在视口底部（单块单击单 toast，多块同显不互相挤占布局） */}
      {toast && (
        <div className="tree-toast" role="status">
          <span className="ok">✓</span>
          <span className="msg">{toast}</span>
        </div>
      )}
    </div>
  );
}
