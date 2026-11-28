// ${VAR} token 渲染与就地填写（config-pages 共享零件，对话框预览与片段卡片复用同一份）。
// 源自原型 config-pages.prototype/parts.tsx 的 CommandText / EditableVar（方案 A 定稿）：
// 已定义 token = amber 点线下划线（悬停 title 显示当前值）；缺失 token = 红字可点，
// 点击原地变输入框，Enter/失焦提交、Esc 取消；已填临时值显示填入的值（amber + 虚线下边框）。
// 颜色约定：token 不加底色 pill——命令本身的可读性优先。
// data-drop-var / data-drop-frag 是拖拽契约属性（file:dropped 按坐标落到 token 上，
// 见 FragmentsView 的订阅），编辑态 input 刻意不带 data-drop-var，避免拖拽时重复写入。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const VAR_SPLIT_RE = /(\$\{[A-Za-z0-9_]+\})/g;
const VAR_TOKEN_RE = /\$\{([A-Za-z0-9_]+)\}$/;

const TOKEN_DEFINED =
  "text-primary underline decoration-primary/45 decoration-dotted underline-offset-[3px]";
const TOKEN_MISSING =
  "text-destructive underline decoration-destructive/55 decoration-dotted underline-offset-[3px]";

/** 缺失变量的可点 token：未填红字可点，点击原地变 input；已填显示填入的值，仍可再点改。 */
function EditableVar({
  name,
  fragIndex,
  value,
  onSubmit,
}: {
  name: string;
  fragIndex: number;
  value?: string;
  onSubmit: (name: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  if (editing) {
    return (
      <input
        aria-label={name}
        autoFocus
        className="my-px inline-block w-full rounded-sm border border-primary/50 bg-background px-1 py-px font-mono text-[11px] text-foreground outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (draft.trim()) onSubmit(name, draft);
          setEditing(false);
        }}
      />
    );
  }

  const filled = value !== undefined;
  return (
    <button
      type="button"
      data-drop-var={name}
      data-drop-frag={fragIndex}
      onClick={() => {
        setDraft(value ?? "");
        setEditing(true);
      }}
      title={filled ? `${name} · ${t("shared.varOverride")}` : t("shared.fillVar", { name })}
      className={cn(
        "rounded-[2px] px-px font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        filled
          ? "border-b border-dashed border-primary/50 text-primary hover:bg-primary/10"
          : cn(TOKEN_MISSING, "cursor-pointer hover:bg-destructive/10"),
      )}
    >
      {filled ? value : `\${${name}}`}
    </button>
  );
}

/** 把 content 里的 ${VAR} 渲染成 token，其余文字原样（span 包裹保持逐段可查询，渲染上等价于裸文本）。
 * interactive=false 时全部退化为纯文字（用在本身就是可点行的折叠态里，避免按钮套按钮）。 */
export function TokenText({
  content,
  vars,
  overrides,
  fragIndex,
  onSetVar,
  interactive = true,
}: {
  content: string;
  vars: Record<string, string>;
  overrides?: Record<string, string>;
  fragIndex?: number;
  onSetVar?: (name: string, value: string) => void;
  interactive?: boolean;
}) {
  return (
    <>
      {content.split(VAR_SPLIT_RE).map((part, i) => {
        const name = VAR_TOKEN_RE.exec(part)?.[1];
        if (!name) return <span key={i}>{part}</span>;
        const value = vars[name];
        if (value !== undefined) {
          return (
            <span key={i} className={TOKEN_DEFINED} title={value}>
              {part}
            </span>
          );
        }
        if (interactive && fragIndex !== undefined && onSetVar) {
          return (
            <EditableVar
              key={i}
              name={name}
              fragIndex={fragIndex}
              value={overrides?.[name]}
              onSubmit={onSetVar}
            />
          );
        }
        const filled = overrides?.[name];
        return (
          <span
            key={i}
            className={filled ? "text-primary" : TOKEN_MISSING}
            title={filled ? name : undefined}
          >
            {filled ?? part}
          </span>
        );
      })}
    </>
  );
}
