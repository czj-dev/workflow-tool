// PROTOTYPE（一次性）：三套变体共用的小零件——只放「各变体都长一样」的东西：
// ${VAR} token 渲染、缺失变量就地填写、搜索框、纯文字按钮、分组依据切换、片段编辑弹窗。
// 版式本身（分区头 / 账本行 / 导览栏）各归各的 Variant 文件，不在此处合并——合并了就比较不出差异。
//
// 颜色约定（三套通用，文字为主）：颜色只出现在 ① ${VAR} token（已定义 = amber 文字 + 点线下划线，
// 缺失 = 红文字，可点填临时值）② hover / 选中反馈 ③ 语义（红 = 重复 / 待确认删除，绿 = 已复制）。
// token 不加底色 pill：命令本身的可读性优先。
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  FloppyDiskIcon,
  Folder01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { FragmentDialog, type FragmentRow } from "../FragmentDialog";
import { IconButton } from "../IconButton";
import { useCopy } from "./copy";
import { setProtoState, type GroupMode } from "./url-state";

const VAR_SPLIT_RE = /(\$\{[A-Za-z0-9_]+\})/g;
const VAR_TOKEN_RE = /\$\{([A-Za-z0-9_]+)\}$/;

const TOKEN_DEFINED =
  "text-primary underline decoration-primary/45 decoration-dotted underline-offset-[3px]";
const TOKEN_MISSING =
  "text-destructive underline decoration-destructive/55 decoration-dotted underline-offset-[3px]";

// ─── ${VAR} token ───────────────────────────────────────────────────────────
// EditableVar：缺失变量的可点 token。未填时红色可点，点击后原地变 input，Enter/失焦提交，
// Esc 取消。已填时显示填入的值（amber + 虚线下边框，区别于全局定义的点线），仍可再点改。
// data-drop-var 让拖入的文件路径直接落到 token 上（见 frag-tools 的 Events 订阅）。
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
  const c = useCopy();
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
      title={filled ? `${name} · ${c.override}` : c.fill("fillVar", { name })}
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

/** 把 content 里的 ${VAR} 渲染成 token，其余原样。
 * interactive=false 时全部退化为纯文字（用在本身就是可点行的折叠态里，避免按钮套按钮）。 */
export function CommandText({
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
        if (!name) return part;
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

// ─── 页框：全页视图 = 页头（SidebarTrigger + 标题 + 右侧工具）+ 正文；抽屉里只要正文（抽屉自带页头）──
// 页头的结构与正式 GlobalConfigEditor / FragmentsView 同构，变的只是正文。
export function PageFrame({
  inSheet,
  title,
  tools,
  children,
}: {
  inSheet: boolean;
  title: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  // 抽屉里不重复画页头（Sheet 自带），但正文仍要占满剩余高度：给一个同构的纵向伸缩容器
  if (inSheet) return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex shrink-0 items-center gap-2">
          <SidebarTrigger />
          <span className="font-semibold">{title}</span>
        </div>
        {tools}
      </header>
      {children}
    </main>
  );
}

/** 新增 + 保存：与正式全局配置页同一对按钮。 */
export function AddSave({
  dirty,
  onAdd,
  onSave,
}: {
  dirty: boolean;
  onAdd: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-1">
      <IconButton icon={Add01Icon} label={t("global.add")} variant="outline" onClick={onAdd} />
      <IconButton
        icon={FloppyDiskIcon}
        label={t("global.save")}
        variant={dirty ? "default" : "outline"}
        dot={dirty}
        disabled={!dirty}
        onClick={onSave}
      />
    </div>
  );
}

/** 「缺定义」清单：片段引用了、全局配置里却没有的变量。每项带「补定义」——点一下就在草稿里加好这个键。 */
export function MissingDefs({
  missing,
  onDefine,
  className,
  bare,
}: {
  missing: { name: string; count: number }[];
  onDefine: (name: string) => void;
  className?: string;
  /** true = 不画标题行（调用方自己已经写了标题，如变体 C 的导览栏选中「缺定义」时） */
  bare?: boolean;
}) {
  const c = useCopy();
  if (missing.length === 0) return null;
  return (
    <div className={className}>
      {!bare && (
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold text-foreground">{c.missingDefs}</span>
          <span className="text-muted-foreground">{c.missingDefsHint}</span>
          <span className="font-mono text-[11px] text-muted-foreground/60 tabular-nums">·{missing.length}</span>
        </div>
      )}
      <div className="mt-1.5 flex flex-col gap-0.5">
        {missing.map((m) => (
          <div key={m.name} className="flex items-center gap-2 font-mono text-xs">
            <span className="text-destructive">{`\${${m.name}}`}</span>
            <span className="text-[11px] text-muted-foreground">{c.fill("refsAt", { n: m.count })}</span>
            <TextButton onClick={() => onDefine(m.name)}>{c.define}</TextButton>
          </div>
        ))}
      </div>
    </div>
  );
}

const UNGROUPED = "__ungrouped__";

/** 手动分组：把一行变量移进某个组的下拉。触发器就是当前组名的纯文字，悬停行时才出现（由调用方给 className）。 */
export function GroupMoveSelect({
  value,
  groups,
  onSelect,
  label,
  ungroupedLabel,
  className,
}: {
  value: string | null;
  groups: string[];
  onSelect: (group: string | null) => void;
  label: string;
  ungroupedLabel: string;
  className?: string;
}) {
  return (
    <Select
      value={value ?? UNGROUPED}
      onValueChange={(v) => onSelect(v === UNGROUPED ? null : String(v))}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        title={label}
        className={cn(
          "h-6 gap-1 border-0 bg-transparent py-0 pr-1 pl-1 font-sans text-[11px] font-normal text-muted-foreground shadow-none hover:border-transparent hover:shadow-none focus-visible:shadow-none [&_svg]:size-3 [&_svg]:text-muted-foreground/60",
          className,
        )}
      >
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.75} className="size-3 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        {groups.map((g) => (
          <SelectItem key={g} value={g}>
            {g}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={UNGROUPED}>{ungroupedLabel}</SelectItem>
      </SelectContent>
    </Select>
  );
}

// ─── 搜索框（与正式页同一个 InputGroup，抽屉的 initialFocus 选择器靠 data-slot 找它）────
export function SearchBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <InputGroup className={cn("h-8", className)}>
      <InputGroupAddon>
        <HugeiconsIcon icon={Search01Icon} className="size-4 text-muted-foreground" />
      </InputGroupAddon>
      <InputGroupInput
        className="font-mono text-xs"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </InputGroup>
  );
}

// ─── 纯文字按钮：动作用字写出来，不靠图标猜 ─────────────────────────────────
export function TextButton({
  children,
  onClick,
  active,
  tone,
  title,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: "danger" | "confirm" | "success";
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "h-6 rounded-[5px] px-1.5 text-xs whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60",
        active && "font-medium text-foreground",
        tone === "danger" && "text-destructive hover:bg-destructive/10 hover:text-destructive",
        tone === "confirm" && "bg-destructive/10 font-medium text-destructive hover:bg-destructive/15",
        tone === "success" && "font-medium text-success hover:bg-success/10 hover:text-success",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** 分组依据切换（全局配置页）。分组模式存在 URL（?group=），三套变体共用同一份状态，
 * 所以这里直接写 store；选中态与侧栏「配置」段的选中项同一支 amber 12%。 */
export function ModeTabs({ value, className }: { value: GroupMode; className?: string }) {
  const c = useCopy();
  const opts: { key: GroupMode; label: string }[] = [
    { key: "prefix", label: c.gmPrefix },
    { key: "usage", label: c.gmUsage },
    { key: "manual", label: c.gmManual },
  ];
  return (
    <div role="radiogroup" aria-label={c.groupBy} className={cn("flex items-center gap-0.5", className)}>
      <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
        {c.groupBy}
      </span>
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          onClick={() => setProtoState({ group: o.key })}
          className={cn(
            "h-6 rounded-[5px] px-1.5 text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/60",
            o.key === value
              ? "bg-sidebar-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 片段新增 / 编辑弹窗：直接复用正式的 FragmentDialog（原型不改它的交互）。 */
export function FragmentDialogHost({
  editing,
  fragments,
  allTags,
  globalConfig,
  onSave,
  onClose,
}: {
  editing: number | null;
  fragments: { title: string; content: string; tags?: string[] }[];
  allTags: string[];
  globalConfig: Record<string, string>;
  onSave: (row: FragmentRow) => void;
  onClose: () => void;
}) {
  if (editing === null) return null;
  const cur = editing >= 0 ? fragments[editing] : null;
  const initial: FragmentRow | null = cur
    ? { title: cur.title, content: cur.content, tags: cur.tags ?? [] }
    : null;
  // key 让每次开弹窗都重挂载，草稿状态天然重置
  return (
    <FragmentDialog
      key={editing}
      open
      initial={initial}
      allTags={allTags}
      definedVars={globalConfig}
      onSave={onSave}
      onClose={onClose}
    />
  );
}

/** 缺失变量提示行：纯文字，不带底色（span + block，可安全放进任何父元素）。 */
export function MissingNote({ missing }: { missing: string[] }) {
  const { t } = useTranslation();
  if (missing.length === 0) return null;
  return (
    <span className="block font-mono text-[10px] leading-4 text-destructive">
      {t("fragments.missingVars")} · {missing.join(" ")}
    </span>
  );
}

const ALL_KEY = "all";
const tabKey = (tag: string | null) => (tag === null ? ALL_KEY : `t:${tag}`);

/** 片段标签页签（片段页 A）：应用现成的分段式 Tabs（设置页「主题 / 语言」同款），一眼读得出「这是一组页签」。
 * 垂直居中：底槽定高 h-8，页签高度取底槽内高的 100%、上下 padding 归零；文字与计数同为 16px 行盒，
 * 由 items-center 居中（旧版 items-baseline 只对齐基线，不负责在按钮高度里居中，所以字偏上）。
 * 标签多到底槽放不下时，底槽内部横向滚动（no-scrollbar），不把页面撑宽。 */
export function SegmentedTabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { tag: string | null; label: string; count: number }[];
  value: string | null;
  onChange: (tag: string | null) => void;
  className?: string;
}) {
  return (
    <Tabs
      value={tabKey(value)}
      onValueChange={(v) => onChange(v === ALL_KEY ? null : String(v).slice(2))}
      className="min-w-0 max-w-full"
    >
      <TabsList className={cn("h-8 max-w-full gap-0.5 overflow-x-auto no-scrollbar", className)}>
        {tabs.map((tab) => (
          <TabsTrigger
            key={tabKey(tab.tag)}
            value={tabKey(tab.tag)}
            className="flex-none gap-1 px-2.5 py-0 text-xs"
          >
            {tab.label}
            <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
              {tab.count}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** tag 文字页签（片段页 B 用；A 改用上面的 SegmentedTabs）：active = 前景字 + amber 下划线，其余灰字；计数跟在后面。 */
export function TagTabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { tag: string | null; label: string; count: number }[];
  value: string | null;
  onChange: (tag: string | null) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("no-scrollbar flex items-center gap-1 overflow-x-auto", className)}>
      {tabs.map((tab) => {
        const active = tab.tag === value;
        return (
          <button
            key={tab.tag ?? "__all"}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.tag)}
            className={cn(
              "flex h-7 shrink-0 items-baseline gap-1 border-b-2 px-1.5 font-mono text-[11px] uppercase tracking-wide outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/50",
              active
                ? "border-primary font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            <span className="tabular-nums opacity-50">{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}
