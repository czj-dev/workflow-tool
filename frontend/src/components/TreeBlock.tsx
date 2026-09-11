import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { flattenTree, searchTree, type FlatNode, type TreeFrame } from "../lib/treeFrame";

// ##[tree] 内联树块（mockup v2.4 定稿视觉，样式见 index.css 的 .treeblock 一节）：
// - 徽标 = 节点 kind 原样渲染，无 kind→文案/颜色映射；label==kind 时不重复显示标签
// - 配色只按结构：容器=主题色、叶子=灰，全走主题 token 亮暗自适应
// - 等宽 │├└ 连接线（与旧 formatTree 同构）；默认展开 2 层（根=0），折叠全部=1，展开全部
// - 块内搜索：命中 label 或 detail；命中+祖先保留，仅 detail 命中的节点降透明，其余隐藏
// - 叶子点击复制完整路径（path 优先，否则根到叶 label 面包屑）+ toast；非叶子点击=折叠
// 逻辑纯函数在 lib/treeFrame.ts，样式在 index.css 的 .treeblock 一节。

// 默认展开深度：depth < DEFAULT_DEPTH 的节点不折叠（根=0 → 根+直接子级可见）。
const DEFAULT_DEPTH = 2;

interface TreeBlockProps {
  frame: TreeFrame;
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

export function TreeBlock({ frame }: TreeBlockProps) {
  const { t } = useTranslation();
  const flat = useMemo(() => flattenTree(frame.nodes ?? []), [frame]);
  const [query, setQuery] = useState("");
  const [depthLimit, setDepthLimit] = useState(DEFAULT_DEPTH);
  // 单节点折叠覆盖（key→是否折叠）；「折叠/展开」按钮改 depthLimit 并清覆盖
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useMemo(() => searchTree(flat, query), [flat, query]);

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
      // 清空搜索：恢复默认深度并清掉单点覆盖（与 mockup setDepth(DEFAULT) 一致）
      setDepthLimit(DEFAULT_DEPTH);
      setOverrides(new Map());
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  const onRowClick = async (f: FlatNode) => {
    if (f.node.children?.length) {
      // 非叶子：切换自身折叠
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(f.key, !(prev.get(f.key) ?? f.depth >= depthLimit));
        return next;
      });
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
          const isLeaf = !f.node.children?.length;
          const dimmed = search?.dim.has(f.key);
          const showLabel = (f.node.label ?? "") !== "" && f.node.label !== f.node.kind;
          return (
            <div key={f.key} role="treeitem" aria-expanded={isLeaf ? undefined : !isCollapsed(f)}>
              <span
                className={cn("tree-row", isLeaf ? "leaf" : "branch", dimmed && "dimmed")}
                role="button"
                tabIndex={0}
                title={isLeaf ? t("tree.copyHint", { path: f.copyText }) : undefined}
                onClick={() => void onRowClick(f)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void onRowClick(f);
                  }
                }}
              >
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
            </div>
          );
        })}
      </div>
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
