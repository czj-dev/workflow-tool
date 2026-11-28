// PROTOTYPE（一次性）：片段「新增 / 编辑」弹窗的原型副本——比正式 FragmentDialog 多一项「卡片颜色」
// （五色色卡 + 实时预览）。不直接改正式弹窗：原型对正式代码只留三个挂载点。
// 定稿时把这一项并进 FragmentDialog（届时片段需要能存下颜色），再删掉本文件。
// 其余字段（标题 / 命令 / 变量回路 / 标签）与正式弹窗逐项相同；TagInput 是逐字副本（正式那个没有导出）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
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
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { extractVars } from "@/lib/vars";
import { cn } from "@/lib/utils";
import type { FragmentRow } from "../FragmentDialog";
import { Swatches } from "./group-ui";
import { useCopy } from "./copy";
import { TINT_CARD, type GroupColor } from "./styles";

// ─── 标签输入（与正式 FragmentDialog 的 TagInput 逐字相同）─────────────────
// chip 式标签编辑。Enter / 逗号 提交，Backspace 删末尾，× 单删；
// 空格属于合法 tag 字符（如 "Lanv AI_BOX"），故不作分隔符。suggestions 走原生 datalist。
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
// 分组的固定色：没选过颜色的片段渲染时跟随它，所以弹窗里也预选它
const GROUP_COLOR: GroupColor = "amber";

function FragColorDialog({
  open,
  initial,
  initialColor,
  allTags,
  definedVars,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: FragmentRow | null;
  initialColor: GroupColor;
  allTags: string[];
  /** 已在全局配置里定义的变量名集合，用于标注引用是否可解析 */
  definedVars: Record<string, string>;
  onSave: (row: FragmentRow, color: GroupColor) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const c = useCopy();
  const [row, setRow] = useState<FragmentRow>(initial ?? EMPTY_ROW);
  const [color, setColor] = useState<GroupColor>(initialColor);

  const vars = extractVars(row.content);
  const canSave = row.title.trim().length > 0 || row.content.trim().length > 0;

  const submit = () => {
    if (!canSave) return;
    onSave(
      {
        title: row.title.trim(),
        content: row.content,
        tags: row.tags,
      },
      color,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      {/* 比正式弹窗多一项色卡，窗口矮时让弹窗自己滚动，保存按钮不至于被顶出屏幕 */}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            {initial ? t("fragments.editTitle") : t("fragments.addTitle")}
          </DialogTitle>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="frag-title">{t("fragments.titlePlaceholder")}</FieldLabel>
            <Input
              id="frag-title"
              value={row.title}
              autoFocus
              onChange={(e) => setRow((r) => ({ ...r, title: e.target.value }))}
              placeholder={t("fragments.titlePlaceholder")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="frag-content">{t("fragments.contentPlaceholder")}</FieldLabel>
            <Textarea
              id="frag-content"
              value={row.content}
              onChange={(e) => setRow((r) => ({ ...r, content: e.target.value }))}
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
                      defined ? "bg-primary/10 text-primary" : "border-destructive/50 bg-transparent",
                    )}
                  >
                    {v}
                  </Badge>
                );
              })}
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="frag-tags">{t("fragments.tagsPlaceholder")}</FieldLabel>
            <TagInput
              id="frag-tags"
              tags={row.tags}
              suggestions={allTags}
              onChange={(tags) => setRow((r) => ({ ...r, tags }))}
            />
          </Field>
          {/* 卡片颜色：与「新建分组」同一支五色色卡。只染这一张卡的底色，标题 / 命令文字不变色 */}
          <Field>
            <FieldTitle>{c.cardColor}</FieldTitle>
            <Swatches value={color} onChange={setColor} label={c.cardColor} />
            <FieldDescription>{c.fragColorHint}</FieldDescription>
            {/* 实时预览：画的就是页面上那张卡（同一支 TINT_CARD + .frag-card 染色），标题 / 命令取已输入的内容 */}
            <article
              data-amb={color}
              aria-hidden="true"
              className={cn("frag-card rounded-md px-2 py-1.5", TINT_CARD)}
            >
              <div className="truncate text-[13px] leading-[18px] font-medium text-foreground">
                {row.title.trim() || c.previewFragTitle}
              </div>
              <div className="mt-0.5 truncate font-mono text-xs leading-5 text-foreground/85">
                {row.content.trim().split("\n")[0] || c.previewFragContent}
              </div>
            </article>
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

/** 片段页变体 A 的新增 / 编辑弹窗宿主：多带一项「这条卡片的颜色」，保存时把选中的颜色一起交回。
 * key 让每次开弹窗都重挂载，草稿状态天然重置。 */
export function FragColorDialogHost({
  editing,
  fragments,
  colors,
  allTags,
  globalConfig,
  onSave,
  onClose,
}: {
  editing: number | null;
  fragments: { title: string; content: string; tags?: string[] }[];
  /** 与 fragments 按下标对齐的卡片颜色（见 frag-tools 的 useFragColors）；null = 没选过 */
  colors: (GroupColor | null)[];
  allTags: string[];
  globalConfig: Record<string, string>;
  onSave: (row: FragmentRow, color: GroupColor) => void;
  onClose: () => void;
}) {
  if (editing === null) return null;
  const cur = editing >= 0 ? fragments[editing] : undefined;
  const initial: FragmentRow | null = cur
    ? { title: cur.title, content: cur.content, tags: cur.tags ?? [] }
    : null;
  const color = editing >= 0 ? (colors[editing] ?? GROUP_COLOR) : GROUP_COLOR;
  return (
    <FragColorDialog
      key={editing}
      open
      initial={initial}
      initialColor={color}
      allTags={allTags}
      definedVars={globalConfig}
      onSave={onSave}
      onClose={onClose}
    />
  );
}
