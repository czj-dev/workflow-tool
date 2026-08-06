import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Copy02Icon,
  Delete02Icon,
  FloppyDiskIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { IconButton } from "./IconButton";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useActionRunner } from "../hooks/useActionRunner";
import { expandVars, extractVars } from "@/lib/vars";
import { cn } from "@/lib/utils";

interface FragmentRow {
  title: string;
  content: string;
  tags: string[];
}

// TagChip：Tag 筛选按钮。active 高亮 primary；label 后跟计数，
// 计数让按钮 textContent ≠ tag 名，避免与分组标题的 getByText 冲突。
function TagChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("ml-1", active ? "opacity-70" : "opacity-50")}>
        {count}
      </span>
    </button>
  );
}

// ─── 使用视图：搜索 + Tag 筛选 → 分组 → 预览+复制（${VAR} 展开，未命中标红） ─
function UseView() {
  const { t } = useTranslation();
  const { fragments, globalConfig } = useActionRunner();
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const query = q.trim().toLowerCase();

  // 所有 tag 及其片段计数，用于 TagList
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    fragments.forEach((f) =>
      f.tags?.forEach((tag) =>
        counts.set(tag, (counts.get(tag) ?? 0) + 1),
      ),
    );
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [fragments]);

  // 搜索 + Tag 双重过滤：命中标题 / 内容 / 任一 tag
  const filtered = useMemo(() => {
    let all = fragments.map((f, i) => ({ f, i }));
    if (activeTag) {
      all = all.filter(({ f }) => (f.tags ?? []).includes(activeTag));
    }
    if (query) {
      all = all.filter(({ f }) =>
        [f.title, f.content, ...(f.tags ?? [])]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }
    return all;
  }, [fragments, activeTag, query]);

  // 分组：选了 tag 归该 tag 一组；未选时按「第一个 tag」归组，避免多 tag 片段重复显示
  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    filtered.forEach(({ f, i }) => {
      const primary = activeTag
        ? activeTag
        : f.tags?.[0] ?? t("fragments.uncategorized");
      const list = map.get(primary) ?? [];
      list.push(i);
      map.set(primary, list);
    });
    return map;
  }, [filtered, activeTag, t]);

  const copyOne = async (i: number) => {
    const text = expandVars(fragments[i].content, globalConfig);
    await navigator.clipboard.writeText(text);
    setCopiedIdx(i);
    setTimeout(() => setCopiedIdx((cur) => (cur === i ? null : cur)), 1200);
  };

  if (fragments.length === 0) {
    return (
      <Empty className="m-4 flex-none">
        <EmptyDescription>{t("fragments.empty")}</EmptyDescription>
      </Empty>
    );
  }

  return (
    <>
      <div className="border-b px-4 py-2">
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            placeholder={t("fragments.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </InputGroup>
      </div>

      {/* TagList：点击筛选，active 高亮；再点同一个或点「全部」取消 */}
      {tagCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
          <TagChip
            label={t("fragments.all")}
            count={fragments.length}
            active={activeTag === null}
            onClick={() => setActiveTag(null)}
          />
          {tagCounts.map(([tag, count]) => (
            <TagChip
              key={tag}
              label={tag}
              count={count}
              active={activeTag === tag}
              onClick={() =>
                setActiveTag((cur) => (cur === tag ? null : tag))
              }
            />
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <Empty className="m-4 flex-none">
          <EmptyDescription>{t("fragments.noResults")}</EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-1 flex-col gap-6 overflow-auto p-4">
          {Array.from(groups.entries()).map(([tag, idxs]) => (
            <section key={tag} className="flex flex-col gap-2">
              <h3 className="flex items-baseline gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                {/* tag 名单独成节点，计数分隔，便于检索与无障碍 */}
                <span>{tag}</span>
                <span className="text-muted-foreground/40">· {idxs.length}</span>
              </h3>
              <ItemGroup>
                {idxs.map((i) => {
                  const f = fragments[i];
                  const preview = expandVars(f.content, globalConfig);
                  const missing = extractVars(f.content).filter(
                    (v) => !(v in globalConfig),
                  );
                  return (
                    <Item
                      key={i}
                      variant="outline"
                      className="transition-colors hover:bg-muted/40"
                    >
                      <ItemContent>
                        <ItemTitle>{f.title || t("fragments.untitled")}</ItemTitle>
                        <ItemDescription className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed line-clamp-3 group-hover/item:line-clamp-none">
                          {preview}
                        </ItemDescription>
                        {missing.length > 0 && (
                          <p className="mt-1 font-mono text-[10px] text-destructive">
                            {t("fragments.missingVars")} · {missing.join(" ")}
                          </p>
                        )}
                      </ItemContent>
                      <ItemActions>
                        <IconButton
                          icon={copiedIdx === i ? CheckmarkCircle02Icon : Copy02Icon}
                          label={
                            copiedIdx === i
                              ? t("fragments.copied")
                              : t("fragments.copy")
                          }
                          variant="outline"
                          className={copiedIdx === i ? "text-success" : undefined}
                          onClick={() => copyOne(i)}
                        />
                      </ItemActions>
                    </Item>
                  );
                })}
              </ItemGroup>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

// TagInput：chip 式标签编辑。Enter / 逗号 提交，Backspace 删末尾，× 单删；
// 空格属于合法 tag 字符（如 "Lanv AI_BOX"），故不作分隔符。
// suggestions 走原生 datalist，无需自建下拉。
function TagInput({
  id,
  tags,
  suggestions,
  onChange,
}: {
  id: string;
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) {
      setDraft("");
      return;
    }
    onChange([...tags, tag]);
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  const listId = `${id}-suggestions`;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {tag}
          <button
            type="button"
            aria-label={`${t("fragments.removeTag")} ${tag}`}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
            className="text-muted-foreground/60 transition-colors hover:text-destructive"
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={tags.length === 0 ? t("fragments.tagsPlaceholder") : ""}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !tags.includes(s))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}

// ─── 编辑视图：CRUD + 保存；去掉骗人的序号，换变量回路 + tags chip ──────
function EditView() {
  const { t } = useTranslation();
  const { fragments, globalConfig, saveFragments } = useActionRunner();

  // 所有已存在的 tag，用于 datalist 自动建议
  const allTags = useMemo(() => {
    const set = new Set<string>();
    fragments.forEach((f) => f.tags?.forEach((tag) => set.add(tag)));
    return Array.from(set).sort();
  }, [fragments]);

  const [rows, setRows] = useState<FragmentRow[]>(() =>
    fragments.map((f) => ({
      title: f.title,
      content: f.content,
      tags: f.tags ?? [],
    })),
  );
  const [dirty, setDirty] = useState(false);

  // fragments（异步）变化时同步 rows：render-time 调整，未编辑时才同步
  const [prevFragments, setPrevFragments] = useState(fragments);
  if (fragments !== prevFragments) {
    setPrevFragments(fragments);
    if (!dirty) {
      setRows(
        fragments.map((f) => ({
          title: f.title,
          content: f.content,
          tags: f.tags ?? [],
        })),
      );
    }
  }

  const update = (i: number, field: "title" | "content", v: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
    setDirty(true);
  };
  // tags 独立增删：去空、去重后写回该行
  const setTags = (i: number, tags: string[]) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, tags } : r)));
    setDirty(true);
  };
  const add = () => {
    setRows((prev) => [...prev, { title: "", content: "", tags: [] }]);
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const save = async () => {
    const list = rows
      .filter((r) => r.title.trim() || r.content.trim())
      .map((r) => ({
        title: r.title.trim(),
        content: r.content,
        tags: r.tags,
      }));
    await saveFragments(list);
    setDirty(false);
  };

  return (
    <>
      <div className="flex items-center justify-end gap-1 border-b px-4 py-2">
        <IconButton icon={Add01Icon} label={t("fragments.add")} variant="outline" onClick={add} />
        <span className="relative">
          <IconButton
            icon={FloppyDiskIcon}
            label={t("fragments.save")}
            variant={dirty ? "default" : "outline"}
            disabled={!dirty}
            onClick={save}
          />
          {dirty && (
            <span className="live-pulse pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
          )}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
        {rows.length === 0 && (
          <Empty className="flex-none">
            <EmptyDescription>{t("fragments.empty")}</EmptyDescription>
          </Empty>
        )}
        {rows.map((r, i) => {
          const vars = extractVars(r.content);
          return (
            <Card key={i} className="relative p-4">
              <IconButton
                icon={Delete02Icon}
                label={t("fragments.remove")}
                className="absolute right-3 top-3 text-muted-foreground/50 hover:text-destructive"
                onClick={() => remove(i)}
              />
              <FieldGroup className="gap-4 pr-8">
                <Field>
                  <FieldLabel htmlFor={`frag-${i}-title`}>
                    {t("fragments.titlePlaceholder")}
                  </FieldLabel>
                  <Input
                    id={`frag-${i}-title`}
                    value={r.title}
                    onChange={(e) => update(i, "title", e.target.value)}
                    placeholder={t("fragments.titlePlaceholder")}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`frag-${i}-content`}>
                    {t("fragments.contentPlaceholder")}
                  </FieldLabel>
                  <Textarea
                    id={`frag-${i}-content`}
                    value={r.content}
                    onChange={(e) => update(i, "content", e.target.value)}
                    placeholder={t("fragments.contentPlaceholder")}
                    rows={3}
                  />
                </Field>
                {/* 变量回路：本片段引用的变量，琥珀=已在全局配置定义 / 红框=缺失 */}
                {vars.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/50">
                      {t("fragments.varsLabel")}
                    </span>
                    {vars.map((v) => {
                      const defined = v in globalConfig;
                      return (
                        <span
                          key={v}
                          className={cn(
                            "rounded-sm px-1.5 py-0.5 font-mono text-[10px]",
                            defined
                              ? "bg-primary/10 text-primary"
                              : "border border-destructive/50 text-destructive",
                          )}
                        >
                          {v}
                        </span>
                      );
                    })}
                  </div>
                )}
                <Field>
                  <FieldLabel htmlFor={`frag-${i}-tags`}>
                    {t("fragments.tagsPlaceholder")}
                  </FieldLabel>
                  <TagInput
                    id={`frag-${i}-tags`}
                    tags={r.tags}
                    suggestions={allTags}
                    onChange={(tags) => setTags(i, tags)}
                  />
                </Field>
              </FieldGroup>
            </Card>
          );
        })}
      </div>
    </>
  );
}

// ─── 主容器：使用/编辑 Tabs 切换 ────────────────────────────────────────
export function FragmentsView() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"use" | "edit">("use");

  return (
    <Tabs
      value={mode}
      onValueChange={(v) => setMode(v as "use" | "edit")}
      className="flex min-w-0 flex-1 flex-col"
    >
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("fragments.title")}</span>
        </div>
        <TabsList>
          <TabsTrigger value="use">{t("fragments.use")}</TabsTrigger>
          <TabsTrigger value="edit">{t("fragments.edit")}</TabsTrigger>
        </TabsList>
      </header>
      <TabsContent value="use" className="flex min-h-0 flex-1 flex-col">
        <UseView />
      </TabsContent>
      <TabsContent value="edit" className="flex min-h-0 flex-1 flex-col">
        <EditView />
      </TabsContent>
    </Tabs>
  );
}
