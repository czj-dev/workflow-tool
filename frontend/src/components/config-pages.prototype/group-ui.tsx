// PROTOTYPE（一次性）：手动分组的「卡片颜色」——五色色卡、新建分组对话框、改色气泡（变体 A）。
// 色卡只改分区色（data-amb → --amb / --tintc / --ink），颜色落在三处：分组头色块、条目 8% 底色（hover 15%）、
// 行首小图标；组名 / 键 / 值 / 计数一律前景色，不随色卡变。
// 创建与改色共用同一支 Swatches：选中 = 实色盘面上的对勾 + 细描边，不加文字徽标。
import { useState, type KeyboardEvent } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Folder01Icon,
  Link01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SectionHead } from "./section";
import {
  EYEBROW,
  GROUP_COLORS,
  HEAD_ACTION,
  SWATCH_BG,
  TINT_CARD,
  type GroupColor,
} from "./styles";
import {
  colorOf,
  createManualGroup,
  nextGroupColor,
  setManualGroupColor,
  useManualGroups,
} from "./var-state";
import { useCopy, type Copy } from "./copy";

const COLOR_NAME: Record<GroupColor, keyof Copy> = {
  amber: "colorAmber",
  green: "colorGreen",
  cyan: "colorCyan",
  blue: "colorBlue",
  violet: "colorViolet",
};

// ─── 五色色卡 ───────────────────────────────────────────────────────────────

/** role=radiogroup + 漫游 Tab（只有选中项在 Tab 序里）：← → ↑ ↓ 即选中新色并把焦点带过去。 */
export function Swatches({
  value,
  onChange,
  label,
  className,
}: {
  value: GroupColor;
  onChange: (color: GroupColor) => void;
  /** 无障碍名（分组头里点开的那份顺带当可见标题用） */
  label: string;
  className?: string;
}) {
  const c = useCopy();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const next =
      GROUP_COLORS[(GROUP_COLORS.indexOf(value) + step + GROUP_COLORS.length) % GROUP_COLORS.length];
    onChange(next);
    // 焦点跟着选中项走：漫游 Tab 下旧按钮已退出 Tab 序，得手动把焦点交给新的那一个
    const radios = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[GROUP_COLORS.indexOf(next)]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex items-center gap-1.5", className)}
    >
      {GROUP_COLORS.map((k) => {
        const on = k === value;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c[COLOR_NAME[k]]}
            title={c[COLOR_NAME[k]]}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(k)}
            className={cn(
              "grid size-7 shrink-0 cursor-pointer place-items-center rounded-[27.5%] outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-ring/60 aria-checked:ring-2 aria-checked:ring-foreground/30 aria-checked:ring-offset-2 aria-checked:ring-offset-popover",
              SWATCH_BG[k],
            )}
          >
            {on && (
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.25} className="size-4 text-background" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── 新建分组 ───────────────────────────────────────────────────────────────

/** 预览里的两行样例：排版同真实条目，用来说明「换色只动色块、底色和行首图标，文字不变」。 */
const PREVIEW_ROWS = [
  { key: "OUTPUT_DIR", value: "${DOCS}/out", refs: 3 },
  { key: "LOGS_DIR", value: "${DOCS}/logs", refs: 1 },
];

/** 名称 + 五色色卡 + 实时预览。按「新建分组」才挂载、关掉即卸载——草稿不用手动重置。 */
export function GroupDialog({ onClose }: { onClose: () => void }) {
  const c = useCopy();
  const { t } = useTranslation();
  const mg = useManualGroups();
  const [name, setName] = useState("");
  const [color, setColor] = useState<GroupColor>(() => nextGroupColor());

  const trimmed = name.trim();
  const dup = trimmed !== "" && mg.order.includes(trimmed);
  const canSubmit = trimmed !== "" && !dup;
  const submit = () => {
    if (!canSubmit) return;
    createManualGroup(trimmed, color);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{c.newGroup}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field data-invalid={dup || undefined}>
            <FieldLabel htmlFor="proto-group-name">{c.groupNameLabel}</FieldLabel>
            <Input
              id="proto-group-name"
              autoFocus
              value={name}
              placeholder={c.groupNamePlaceholder}
              aria-invalid={dup}
              aria-describedby={dup ? "proto-group-name-error" : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {dup && <FieldError id="proto-group-name-error">{c.dupGroupName}</FieldError>}
          </Field>
          <Field>
            <FieldTitle>{c.cardColor}</FieldTitle>
            <Swatches value={color} onChange={setColor} label={c.cardColor} />
            <FieldDescription>{c.cardColorHint}</FieldDescription>
          </Field>

          {/* 实时预览：画的就是页面上的分区（同一个 SectionHead + 同一支条目卡） */}
          <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>{c.preview}</span>
            <div className="pointer-events-none rounded-md bg-background p-2" aria-hidden="true">
              <section
                data-amb={color}
                className="side-sec rounded-lg border-t border-sidebar-border px-2 pt-2 pb-3"
              >
                <SectionHead
                  icon={Folder01Icon}
                  name={trimmed || c.previewGroup}
                  sub={c.gmManualHint}
                  count={PREVIEW_ROWS.length}
                />
                <div className="flex flex-col gap-1">
                  {PREVIEW_ROWS.map((r) => (
                    <div
                      key={r.key}
                      className={cn("flex min-h-8 items-center gap-2 rounded-md px-2", TINT_CARD)}
                    >
                      <HugeiconsIcon
                        icon={Link01Icon}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-[color:var(--ink)]"
                      />
                      <span className="w-[21ch] flex-none truncate font-mono text-xs font-semibold uppercase tracking-wide text-foreground">
                        {r.key}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground/45" aria-hidden="true">
                        =
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {r.value}
                      </span>
                      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                        {t("global.refCount", { count: r.refs })}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("fragments.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {c.newGroup}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── 改色 ───────────────────────────────────────────────────────────────────

/** 分组头右侧的「当前色 + ⌄」小按钮，点开是同一支五色色卡；点了即刻生效，气泡不关，方便连着试。
 * secId = 所在分区的 data-sec：气泡在 portal 里，带上它，焦点落进气泡时所在分区照样算「正在交互」。 */
export function GroupColorPicker({ name, secId }: { name: string; secId: string }) {
  const c = useCopy();
  const mg = useManualGroups();
  const value = colorOf(mg, name);
  const label = c.fill("groupColorOf", { name });

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "flex size-8 cursor-pointer items-center justify-center gap-1 rounded-[min(var(--radius-md),10px)] outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted",
          HEAD_ACTION,
        )}
      >
        <span className={cn("block size-3.5 rounded-[27.5%]", SWATCH_BG[value])} />
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          aria-hidden="true"
          className="size-3 text-muted-foreground/70"
        />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" align="end" sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            data-sec={secId}
            aria-label={label}
            className="relative isolate z-50 w-max origin-(--transform-origin) rounded-md bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center gap-1.5 px-0.5 pb-2 text-xs text-muted-foreground">
              <span className={cn("block size-3 shrink-0 rounded-[27.5%]", SWATCH_BG[value])} />
              <span className="max-w-48 truncate">{label}</span>
            </div>
            <Swatches
              value={value}
              onChange={(k) => setManualGroupColor(name, k)}
              label={label}
            />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
