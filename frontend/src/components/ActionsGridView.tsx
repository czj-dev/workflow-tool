import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY } from "../hooks/useActionUsage";
import { missingRequired, resolveActionParams } from "../lib/params";
import { ActionIcon } from "./ActionIcon";
import { ActionPresetRing } from "./ActionPresetRing";
import { ringGeometry, ringHit, type RingGeometry } from "./actionRingGeometry";
import { TickRuler, StatusRail, RunningFlow } from "./GridCardParts";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { Preset } from "../../bindings/workflow-tool/internal/registry/models.js";

const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

const ICON_TINT = [
  { bg: "bg-primary/10", glow: "shadow-primary/20" },
  { bg: "bg-primary/16", glow: "shadow-primary/25" },
  { bg: "bg-primary/22", glow: "shadow-primary/30" },
  { bg: "bg-primary/30", glow: "shadow-primary/40" },
  { bg: "bg-primary/40", glow: "shadow-primary/50" },
] as const;

const HOLD_DELAY_MS = 450;
const MOVE_THRESHOLD = 8;
const MIN_RING_RADIUS = 28;

type Hold = { pointerId: number; x: number; y: number; phase: "pressing" | "scrolling" | "open" };
type OpenRing = { geometry: RingGeometry; selected: number; keyboard: boolean; cursor?: { x: number; y: number } };

export function ActionsGridView() {
  const { t } = useTranslation();
  const { actions, globalConfig, runAction, selectPreset, isRunning, focusRunning } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } = useActionUsage();
  const [openId, setOpenId] = useState<string | null>(null);

  const shellActions = actions.filter((a) => !a.llm);
  const groups = groupByPrefix(shellActions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
    if (a === MISC_KEY) return 1;
    if (b === MISC_KEY) return -1;
    return a.localeCompare(b);
  });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-sm font-semibold">{t("grid.title")}</h1>
        </div>
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: shellActions.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupEntries.length })}
        </span>
      </header>

      <div className="p-4 space-y-6">
        {shellActions.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
            <span className={EYEBROW}>{t("grid.emptyEyebrow")}</span>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("grid.empty")}</p>
          </div>
        )}
        {groupEntries.map(([key, items]) => {
          const lit = items.reduce((n, it) => (getScore(it.id) > 0 ? n + 1 : n), 0);
          return (
            <section key={key}>
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 pb-3">
                <span className={EYEBROW}>{key === MISC_KEY ? t("grid.groupMisc") : groupLabel(key)}</span>
                <TickRuler total={items.length} lit={lit} />
                <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground tabular-nums">
                  {items.length} {t("grid.slots")}
                </span>
              </div>
              <div className="grid select-none grid-cols-[repeat(auto-fill,130px)] justify-start gap-2.5">
                {topActions(items, items.length).map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    running={isRunning(action.id)}
                    level={footprintLevel(action.id)}
                    score={getScore(action.id)}
                    globalConfig={globalConfig}
                    isOpen={openId === action.id}
                    onOpen={() => setOpenId(action.id)}
                    onClose={() => setOpenId((current) => current === action.id ? null : current)}
                    onRun={(values) => { void runAction(action.id, values); }}
                    onEdit={() => selectPreset(action.id, "")}
                    onFocus={() => focusRunning(action.id, action.stream === "logcat" ? "logcat" : "output")}
                    onPresetEdit={(name) => selectPreset(action.id, name)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

interface ActionCardProps {
  action: ActionItem;
  running: boolean;
  level: number;
  score: number;
  globalConfig: Record<string, string>;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRun: (values: Record<string, string>) => void;
  onEdit: () => void;
  onFocus: () => void;
  onPresetEdit: (name: string) => void;
}

function ActionCard({
  action, running, level, score, globalConfig, isOpen, onOpen, onClose, onRun, onEdit, onFocus, onPresetEdit,
}: ActionCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<Hold | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const ringRef = useRef<OpenRing | null>(null);
  const [ring, setRing] = useState<OpenRing | null>(null);
  const presets = action.presets ?? [];
  const canOpen = presets.length > 0 && !running;
  const activeRing = isOpen ? ring : null;
  const isPointerRingOpen = !!activeRing && !activeRing.keyboard;

  useEffect(() => {
    if (!isPointerRingOpen) return;
    const card = cardRef.current;
    const preventScroll = (event: TouchEvent) => event.preventDefault();
    card?.addEventListener("touchmove", preventScroll, { passive: false });
    document.body.classList.add("preset-ring-selecting");
    window.getSelection()?.removeAllRanges();
    return () => {
      card?.removeEventListener("touchmove", preventScroll);
      document.body.classList.remove("preset-ring-selecting");
    };
  }, [isPointerRingOpen]);

  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const closeRing = () => {
    ringRef.current = null;
    setRing(null);
    onClose();
  };
  const suppressNextClick = () => {
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };
  const activate = (preset?: Preset) => {
    if (running) { onFocus(); return; }
    const values = resolveActionParams(action.params ?? [], globalConfig, preset?.values);
    if (missingRequired(action.params ?? [], values).length) {
      onPresetEdit(preset?.name ?? "");
    } else {
      const runValues = preset
        ? Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== "" || Object.hasOwn(preset.values ?? {}, key)))
        : values;
      onRun(runValues);
    }
  };
  const openRing = (keyboard: boolean) => {
    if (!canOpen || !cardRef.current) return;
    const geometry = ringGeometry(cardRef.current.getBoundingClientRect(), presets.length);
    if (geometry.outer < MIN_RING_RADIUS) return;
    const next = { geometry, selected: -1, keyboard };
    ringRef.current = next;
    setRing(next);
    onOpen();
  };
  const select = (index: number, cursor?: { x: number; y: number }) => {
    if (!ringRef.current || (ringRef.current.selected === index && (!cursor || index < 0))) return;
    const next = { ...ringRef.current, selected: index, cursor };
    ringRef.current = next;
    setRing(next);
  };
  const choose = (index: number) => {
    const preset = presets[index];
    closeRing();
    if (preset) activate(preset);
  };

  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);
  useEffect(() => {
    if (isOpen) return;
    ringRef.current = null;
    holdRef.current = null;
    clearTimer();
    // 上一个卡片的环被关闭时，其状态不能残留到下次打开。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRing(null);
  }, [isOpen]);
  useEffect(() => {
    if (!activeRing) return;
    const close = () => closeRing();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRing?.geometry]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canOpen || event.button !== 0 || holdRef.current || (event.target as Element).closest("button")) return;
    holdRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, phase: "pressing" };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (holdRef.current?.phase !== "pressing") return;
      holdRef.current = { ...holdRef.current, phase: "open" };
      openRing(false);
    }, HOLD_DELAY_MS);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const hold = holdRef.current;
    if (!hold || hold.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > MOVE_THRESHOLD;
    if (hold.phase === "pressing" && moved) {
      clearTimer();
      holdRef.current = { ...hold, phase: "scrolling" };
    }
    if (hold.phase === "open" && ringRef.current) {
      select(moved ? ringHit(ringRef.current.geometry, event.clientX, event.clientY, ringRef.current.selected) : -1,
        { x: event.clientX, y: event.clientY });
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const hold = holdRef.current;
    if (!hold || hold.pointerId !== event.pointerId) return;
    clearTimer();
    holdRef.current = null;
    if (hold.phase === "pressing") return;
    suppressNextClick();
    if (hold.phase === "open" && ringRef.current) {
      const moved = Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > MOVE_THRESHOLD;
      const index = moved ? ringHit(ringRef.current.geometry, event.clientX, event.clientY, ringRef.current.selected) : -1;
      if (index >= 0) choose(index);
      else closeRing();
    }
  };
  const onPointerCancel = () => {
    if (!holdRef.current) return;
    clearTimer();
    if (holdRef.current.phase === "open") closeRing();
    holdRef.current = null;
    suppressNextClick();
  };

  const tip = [action.description, presets.length ? `${t("form.presetsLabel")}: ${presets.map((p) => p.name).join(" / ")}` : null]
    .filter(Boolean).join("\n");

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      aria-label={action.title}
      aria-expanded={canOpen ? !!activeRing : undefined}
      aria-keyshortcuts={canOpen ? "Shift+F10" : undefined}
      title={tip || action.title}
      onClick={() => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        if (activeRing) { closeRing(); return; }
        activate();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.shiftKey && event.key === "F10" && canOpen) { event.preventDefault(); openRing(true); return; }
        if (activeRing?.keyboard) {
          if (event.key === "Escape") { event.preventDefault(); closeRing(); cardRef.current?.focus(); return; }
          if (event.key === "Tab") { closeRing(); return; }
          if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
            select((activeRing.selected + direction + presets.length) % presets.length);
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (event.key === "Enter" && activeRing.selected >= 0) choose(activeRing.selected);
            return;
          }
        }
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={(event) => { if (holdRef.current?.pointerId === event.pointerId) onPointerCancel(); }}
      data-running={running || undefined}
      className={`
        group relative aspect-square cursor-pointer border
        bg-gradient-to-b from-card to-background/70
        shadow-[0_1px_2px_rgb(0_0_0/0.1),0_2px_5px_rgb(0_0_0/0.06)]
        transition-[border-color,box-shadow,translate,border-radius,scale] duration-150 ease-out
        after:pointer-events-none after:absolute after:inset-x-2.5 after:top-px after:h-px
        after:bg-gradient-to-r after:from-transparent after:via-card-foreground/12 after:to-transparent
        hover:-translate-y-px hover:border-primary/60
        hover:shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]
        focus-visible:-translate-y-px focus-visible:border-primary/60
        focus-visible:shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60
        active:translate-y-px active:shadow-[0_0_1px_rgb(0_0_0/0.1),inset_0_1px_3px_rgb(0_0_0/0.18)]
        motion-reduce:transition-none
        ${activeRing ? "rounded-full z-10 border-primary after:opacity-0" : "rounded-xl"}
        ${running ? "border-primary" : "border-border"}
      `}
      style={activeRing ? { scale: Math.min(1, (activeRing.geometry.inner - 4) / 65) } : undefined}
    >
      <div className={`absolute inset-0 flex flex-col items-center bg-gradient-to-b from-card to-background/70 p-1.5 ${activeRing ? "rounded-full overflow-hidden" : "rounded-[11px]"}`}>
        {running && <RunningFlow className={activeRing ? "rounded-t-full" : "rounded-t-[11px]"} />}
        <StatusRail level={level} score={score} compact />
        <span className="flex flex-1 items-center justify-center">
          <span className={`flex size-[50px] items-center justify-center rounded-xl text-primary shadow-[inset_0_0_14px] ${ICON_TINT[Math.min(level, ICON_TINT.length - 1)].bg} ${ICON_TINT[Math.min(level, ICON_TINT.length - 1)].glow}`}>
            <ActionIcon name={action.icon} className="size-6" />
          </span>
        </span>
        <span className="w-full truncate text-center font-mono text-xs font-semibold leading-tight">{action.title}</span>
        <span className="mt-0.5 flex h-1.5 items-center justify-center gap-1">
          {presets.length ? presets.map((p) => <i key={p.name} className="size-1 rounded-full bg-primary/40" aria-hidden="true" />) : <i className="invisible size-1" aria-hidden="true" />}
        </span>
        {!activeRing && (
          <button
            type="button"
            aria-label={t("grid.editParams")}
            title={t("grid.editParams")}
            onClick={(event) => { event.stopPropagation(); onEdit(); }}
            className="absolute right-1 top-1 z-10 grid size-7 place-items-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-card hover:text-foreground cursor-pointer"
          >
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-3" />
          </button>
        )}
      </div>
      {activeRing && (
        <>
          <span className="sr-only" aria-live="polite">
            {activeRing.selected >= 0 ? t("grid.ringSelected", { name: presets[activeRing.selected].name }) : t("grid.ringOpen")}
          </span>
          <ActionPresetRing
            presets={presets}
            geometry={activeRing.geometry}
            selected={activeRing.selected}
            cursor={activeRing.cursor}
            keyboard={activeRing.keyboard}
            label={t("form.presetsLabel")}
            onChoose={choose}
            onHover={select}
          />
        </>
      )}
    </div>
  );
}
