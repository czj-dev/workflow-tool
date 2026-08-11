import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { extractVars } from "@/lib/vars";
import { cn } from "@/lib/utils";

export interface FragmentRow {
  title: string;
  content: string;
  tags: string[];
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

const EMPTY_ROW: FragmentRow = { title: "", content: "", tags: [] };

// 片段编辑弹窗：新增与编辑同一交互。initial 为 null 即新增模式。
// 由父层用 key 控制重挂载来重置草稿，避免 useEffect 同步 props→state。
export function FragmentDialog({
  open,
  initial,
  allTags,
  definedVars,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: FragmentRow | null;
  allTags: string[];
  /** 已在全局配置里定义的变量名集合，用于标注引用是否可解析 */
  definedVars: Record<string, string>;
  onSave: (row: FragmentRow) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [row, setRow] = useState<FragmentRow>(initial ?? EMPTY_ROW);

  const vars = extractVars(row.content);
  const canSave = row.title.trim().length > 0 || row.content.trim().length > 0;

  const submit = () => {
    if (!canSave) return;
    onSave({
      title: row.title.trim(),
      content: row.content,
      tags: row.tags,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {initial ? t("fragments.editTitle") : t("fragments.addTitle")}
          </DialogTitle>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="frag-title">
              {t("fragments.titlePlaceholder")}
            </FieldLabel>
            <Input
              id="frag-title"
              value={row.title}
              autoFocus
              onChange={(e) => setRow((r) => ({ ...r, title: e.target.value }))}
              placeholder={t("fragments.titlePlaceholder")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="frag-content">
              {t("fragments.contentPlaceholder")}
            </FieldLabel>
            <Textarea
              id="frag-content"
              value={row.content}
              onChange={(e) =>
                setRow((r) => ({ ...r, content: e.target.value }))
              }
              placeholder={t("fragments.contentPlaceholder")}
              className="max-h-72 min-h-24 font-mono text-xs leading-relaxed"
            />
          </Field>
          {/* 变量回路：本片段引用的变量，琥珀=已在全局配置定义 / 红框=缺失 */}
          {vars.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/50">
                {t("fragments.varsLabel")}
              </span>
              {vars.map((v) => {
                const defined = v in definedVars;
                return (
                  <Badge
                    key={v}
                    variant={defined ? "default" : "destructive"}
                    className={cn(
                      "rounded-sm font-mono text-[10px]",
                      defined
                        ? "bg-primary/10 text-primary"
                        : "border-destructive/50 bg-transparent",
                    )}
                  >
                    {v}
                  </Badge>
                );
              })}
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="frag-tags">
              {t("fragments.tagsPlaceholder")}
            </FieldLabel>
            <TagInput
              id="frag-tags"
              tags={row.tags}
              suggestions={allTags}
              onChange={(tags) => setRow((r) => ({ ...r, tags }))}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("fragments.cancel")}
          </Button>
          <Button disabled={!canSave} onClick={submit}>
            {t("fragments.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
