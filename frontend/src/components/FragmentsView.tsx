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
  tags: string; // 逗号分隔的字符串，保存时转 []string
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

  // 分组：选了 tag 只显示该 tag 一组；否则按全部 tag 分组，无 tag 归「未分类」
  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    filtered.forEach(({ f, i }) => {
      let tags: string[];
      if (activeTag) {
        if (!(f.tags ?? []).includes(activeTag)) return;
        tags = [activeTag];
      } else {
        tags = f.tags?.length ? f.tags : [t("fragments.uncategorized")];
      }
      tags.forEach((tag) => {
        const list = map.get(tag) ?? [];
        list.push(i);
        map.set(tag, list);
      });
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

// ─── 编辑视图：CRUD + 保存；去掉骗人的序号，换变量回路 + tags chip ──────
function EditView() {
  const { t } = useTranslation();
  const { fragments, globalConfig, saveFragments } = useActionRunner();
  const [rows, setRows] = useState<FragmentRow[]>(() =>
    fragments.map((f) => ({
      title: f.title,
      content: f.content,
      tags: (f.tags ?? []).join(", "),
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
          tags: (f.tags ?? []).join(", "),
        })),
      );
    }
  }

  const update = (i: number, field: keyof FragmentRow, v: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
    setDirty(true);
  };
  const add = () => {
    setRows((prev) => [...prev, { title: "", content: "", tags: "" }]);
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
        tags: r.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
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
          const tagChips = r.tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
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
                  <Input
                    id={`frag-${i}-tags`}
                    value={r.tags}
                    onChange={(e) => update(i, "tags", e.target.value)}
                    placeholder={t("fragments.tagsPlaceholder")}
                  />
                  {tagChips.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {tagChips.map((tag, ti) => (
                        <span
                          key={ti}
                          className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
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
