// PROTOTYPE（一次性）：原型切换条——切变体 / 翻页 / 回「现行版」对照。
// 锚在主区左下角、前景色反白：它是「原型工具」而不是产品 UI，不该和页面抢同一套视觉语言。
// 只在原型会话里由 host.tsx 挂载（见 slot.tsx），生产包不含本文件。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { useCopy } from "./copy";
import {
  readProtoState,
  setProtoState,
  stepVariant,
  useProtoState,
  VARIANTS,
  type ProtoPageId,
} from "./url-state";

const STEP =
  "grid size-5 shrink-0 place-items-center rounded-[4px] outline-none transition-colors hover:bg-background/15 focus-visible:ring-1 focus-visible:ring-background/50";
const SEG =
  "h-5 shrink-0 rounded-[4px] px-1.5 text-xs outline-none transition-colors hover:bg-background/15 focus-visible:ring-1 focus-visible:ring-background/50";
const SEG_ON = "bg-background/20 font-medium";
const DIVIDER = <span className="mx-1 h-3 w-px shrink-0 bg-background/20" aria-hidden="true" />;

// 焦点落在这些元素上时，← → 归它们自己（输入光标 / 单选组 / 页签的方向键），不切变体
const OWNS_ARROWS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='radiogroup'], [role='tablist'], [role='slider'], [role='listbox'], [role='menu']";

export function PrototypeSwitcher({
  page,
  onPage,
}: {
  page: ProtoPageId;
  onPage: (p: ProtoPageId) => void;
}) {
  const c = useCopy();
  const { t } = useTranslation();
  const { variant } = useProtoState();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = e.target;
      if (el instanceof Element && el.closest(OWNS_ARROWS)) return;
      e.preventDefault();
      setProtoState({
        variant: stepVariant(readProtoState().variant, e.key === "ArrowRight" ? 1 : -1),
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const step = (dir: 1 | -1) =>
    setProtoState({ variant: stepVariant(readProtoState().variant, dir) });
  const cur = VARIANTS.find((v) => v.key === variant) ?? null;

  return (
    <div className="absolute bottom-3 left-3 z-40 max-w-[calc(100%-1.5rem)] rounded-lg bg-foreground px-3 py-2 text-background shadow-[0_8px_24px_rgb(0_0_0/0.28)]">
      <div className="flex items-center gap-1 text-xs">
        <span className="mr-1 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] opacity-60">
          [{c.prototype}]
        </span>
        <button
          type="button"
          aria-label={c.prevVariant}
          title={c.prevVariant}
          onClick={() => step(-1)}
          className={STEP}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={c.toggleNote}
          aria-expanded={open}
          className="h-5 min-w-[8.25em] shrink-0 rounded-[4px] px-1.5 text-left font-medium outline-none transition-colors hover:bg-background/15 focus-visible:ring-1 focus-visible:ring-background/50"
        >
          {cur ? `${cur.key} · ${cur.name}` : c.currentImpl}
        </button>
        <button
          type="button"
          aria-label={c.nextVariant}
          title={c.nextVariant}
          onClick={() => step(1)}
          className={STEP}
        >
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
        </button>
        {DIVIDER}
        <button
          type="button"
          onClick={() => onPage("global")}
          aria-pressed={page === "global"}
          className={cn(SEG, page === "global" && SEG_ON)}
        >
          {t("global.title")}
        </button>
        <button
          type="button"
          onClick={() => onPage("fragments")}
          aria-pressed={page === "fragments"}
          className={cn(SEG, page === "fragments" && SEG_ON)}
        >
          {t("fragments.title")}
        </button>
        {variant !== null && (
          <>
            {DIVIDER}
            <button type="button" onClick={() => setProtoState({ variant: null })} className={SEG}>
              {c.currentImpl}
            </button>
          </>
        )}
      </div>
      {open && (
        <p className="mt-1.5 max-w-[36em] text-[11px] leading-4 opacity-75">
          {cur ? cur.idea : c.currentImplHint}
          <span className="ml-2 opacity-60">{c.switchHint}</span>
        </p>
      )}
    </div>
  );
}
