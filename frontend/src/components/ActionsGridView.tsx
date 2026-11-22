import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY } from "../hooks/useActionUsage";
import { missingRequired, resolveActionParams } from "../lib/params";
import { ActionIcon } from "./ActionIcon";
import { ActionPresetRing } from "./ActionPresetRing";
import { ringGeometry, ringHit, MIN_RING_BAND, type RingGeometry } from "./actionRingGeometry";
import { TickRuler, RunningFlow } from "./GridCardParts";
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

// hub 形变弹簧曲线：开环时圆角方块 → 正圆盘（scale 1.8，直径 72 == 内孔直径）
const HUB_EASE = "ease-[cubic-bezier(0.2,0.85,0.3,1.18)]";

const HOLD_DELAY_MS = 450;
const MOVE_THRESHOLD = 8;
// 按下动画编排(单位 ms):hub 先形变为正圆盘(~200ms CSS transition),
// 扇形折扇展开的延迟见 ActionPresetRing 的 RING_OPEN_DELAY_MS。
const RING_EXIT_MS = 210;   // 关环:折扇收束(fold 200ms)后再卸载
const PETAL_PLUCK_MS = 300; // 摘瓣:选中扇片飘出后才开始执行事件

type Hold = { pointerId: number; x: number; y: number; phase: "pressing" | "scrolling" | "open" };
type OpenRing = {
  geometry: RingGeometry;
  selected: number;
  keyboard: boolean;
  cursor?: { x: number; y: number };
  exiting?: boolean;
  plucking?: number;
};

export function ActionsGridView() {
  const { t } = useTranslation();
  const { actions, globalConfig, runAction, selectPreset, isRunning, focusRunning } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } = useActionUsage();
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const allShellActions = actions.filter((a) => !a.llm);
  // 头部搜索（FragmentsList 同款）：命中 标题 / id / 描述，小写子串
  const normalized = query.trim().toLowerCase();
  const shellActions = normalized
    ? allShellActions.filter((a) => [a.title, a.id, a.description ?? ""].join(" ").toLowerCase().includes(normalized))
    : allShellActions;
  const groups = groupByPrefix(shellActions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
    if (a === MISC_KEY) return 1;
    if (b === MISC_KEY) return -1;
    return a.localeCompare(b);
  });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <h1 className="flex-none text-sm font-semibold">{t("grid.title")}</h1>
        <InputGroup className="ml-1 w-full max-w-sm">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("grid.searchPlaceholder")}
            placeholder={t("grid.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>
        <span className="ml-auto font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: shellActions.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupEntries.length })}
        </span>
      </header>

      <div className="p-4 space-y-6">
        {allShellActions.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
            <span className={EYEBROW}>{t("grid.emptyEyebrow")}</span>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("grid.empty")}</p>
          </div>
        )}
        {allShellActions.length > 0 && shellActions.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
            <span className={EYEBROW}>{t("grid.noResultsEyebrow")}</span>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("grid.noResults")}</p>
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
              <div className="grid select-none grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-2.5">
                {topActions(items, items.length).map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    running={isRunning(action.id)}
                    level={footprintLevel(action.id)}
                    globalConfig={globalConfig}
                    isOpen={openId === action.id}
                    dimmed={openId !== null && openId !== action.id}
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
  globalConfig: Record<string, string>;
  isOpen: boolean;
  dimmed: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRun: (values: Record<string, string>) => void;
  onEdit: () => void;
  onFocus: () => void;
  onPresetEdit: (name: string) => void;
}

function ActionCard({
  action, running, level, globalConfig, isOpen, dimmed, onOpen, onClose, onRun, onEdit, onFocus, onPresetEdit,
}: ActionCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<Hold | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const ringRef = useRef<OpenRing | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ring, setRing] = useState<OpenRing | null>(null);
  const presets = action.presets ?? [];
  const canOpen = presets.length > 0 && !running;
  // activeRing:渲染用(含退场/摘瓣动画期);liveRing:交互语义上的“环开着”
  // —— 动画期间视为已关闭:点击立即回落默认行为,选区锁定即时解除。
  const activeRing = isOpen ? ring : null;
  const liveRing = activeRing && !activeRing.exiting && activeRing.plucking === undefined ? activeRing : null;
  const isPointerRingOpen = !!liveRing && !liveRing.keyboard;
  const tint = ICON_TINT[Math.min(level, ICON_TINT.length - 1)];

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
  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  // 关环不再瞬时卸载:先播反向收起动画(花瓣缩回环心),结束才卸载并上报关闭。
  const closeRing = () => {
    const current = ringRef.current;
    if (!current || current.exiting || current.plucking !== undefined) return;
    const next = { ...current, exiting: true };
    ringRef.current = next;
    setRing(next);
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      if (!ringRef.current?.exiting) return; // 期间被重新打开则作废
      ringRef.current = null;
      setRing(null);
      onClose();
    }, RING_EXIT_MS);
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
    if (!canOpen || !cardRef.current || !hubRef.current) return;
    clearCloseTimer(); // 若正处于退场中,作废未完成的关闭
    // 锚点 = hub 中心；内孔直径 = 卡高（正圆盘 hub 开环时填满内孔）
    const geometry = ringGeometry(
      hubRef.current.getBoundingClientRect(),
      presets.length,
      cardRef.current.getBoundingClientRect().height,
    );
    if (geometry.outer < geometry.inner + MIN_RING_BAND) return;
    const next = { geometry, selected: -1, keyboard };
    ringRef.current = next;
    setRing(next);
    onOpen();
  };
  const select = (index: number, cursor?: { x: number; y: number }) => {
    const current = ringRef.current;
    if (!current || current.exiting || current.plucking !== undefined) return;
    if (current.selected === index && (!cursor || index < 0)) return;
    const next = { ...current, selected: index, cursor };
    ringRef.current = next;
    setRing(next);
  };
  // 摘瓣:选中扇片向外飘出、其余缩回,动画结束才真正执行事件(从花里摘了一片的感觉)
  const choose = (index: number) => {
    const current = ringRef.current;
    const preset = presets[index];
    if (!current || current.exiting || current.plucking !== undefined) return;
    const next = { ...current, plucking: index, selected: index };
    ringRef.current = next;
    setRing(next);
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      // 期间环被其他路径关闭/重开时不重复关,但事件必须执行(用户已选)
      if (ringRef.current === next) {
        ringRef.current = null;
        setRing(null);
        onClose();
      }
      if (preset) activate(preset);
    }, PETAL_PLUCK_MS);
  };

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
  }, []);
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
      aria-expanded={canOpen ? !!liveRing : undefined}
      aria-keyshortcuts={canOpen ? "Shift+F10" : undefined}
      title={tip || action.title}
      onClick={() => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        if (liveRing) { closeRing(); return; }
        activate();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.shiftKey && event.key === "F10" && canOpen) { event.preventDefault(); openRing(true); return; }
        if (liveRing?.keyboard) {
          if (event.key === "Escape") { event.preventDefault(); closeRing(); cardRef.current?.focus(); return; }
          if (event.key === "Tab") { closeRing(); return; }
          if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
            select((liveRing.selected + direction + presets.length) % presets.length);
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (event.key === "Enter" && liveRing.selected >= 0) choose(liveRing.selected);
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
        group relative flex h-[72px] cursor-pointer select-none items-center gap-3 rounded-xl border px-3
        bg-gradient-to-b from-card to-background/70
        transition-[border-color,box-shadow,translate,opacity,scale] duration-150 ease-out
        after:pointer-events-none after:absolute after:inset-x-2.5 after:top-px after:h-px
        after:bg-gradient-to-r after:from-transparent after:via-card-foreground/12 after:to-transparent
        hover:-translate-y-px hover:border-primary/60
        hover:shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]
        focus-visible:-translate-y-px focus-visible:border-primary/60
        focus-visible:shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60
        active:translate-y-px
        motion-reduce:transition-none
        ${dimmed ? "opacity-40 scale-[0.985]" : ""}
        ${activeRing
          ? "z-10 border-primary after:opacity-0 ring-4 ring-primary/15 shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]"
          : running
            ? "border-primary shadow-[0_1px_2px_rgb(0_0_0/0.1),0_2px_5px_rgb(0_0_0/0.06)]"
            : "border-border shadow-[0_1px_2px_rgb(0_0_0/0.1),0_2px_5px_rgb(0_0_0/0.06)]"}
      `}
    >
      {running && <RunningFlow className="rounded-t-[11px]" />}
      <div
        ref={hubRef}
        className={`action-hub relative grid size-10 flex-none place-items-center rounded-[27.5%]
          transition-[transform,border-radius,background-color,color,box-shadow] duration-[200ms] ${HUB_EASE} motion-reduce:transition-none
          ${activeRing
            ? // 圆盘态用 50% 而非 rounded-full(9999px):9999px↔27.5% 插值时前段一直等效全圆，
              // 方形度只在动画尾部瞬间恢复，收尾会“跳”一下；50%↔27.5% 则全程线性同步
              "scale-[1.8] rounded-[50%] bg-primary text-primary-foreground shadow-[0_2px_12px_rgb(0_0_0/0.3)]"
            : // 按住时轻微收缩作预备(蓄力)，开环时从收缩位弹开成正圆盘；
              // 圆角用百分比(40px×27.5%=11px)以便随 scale 同步放大，避免“先变大再变圆”
              `group-active:scale-[0.96] text-primary shadow-[inset_0_0_12px] ${tint.bg} ${tint.glow}`}`}
      >
        {/* 图标尺寸固定不变：完全由 hub 的 scale 带动，避免父级缩放与自身尺寸两条曲线叠加造成跳变 */}
        <ActionIcon name={action.icon} className="size-5" />
      </div>
      <div className={`flex min-w-0 flex-1 flex-col gap-0.5 transition-opacity duration-150 ${activeRing ? "opacity-30" : ""}`}>
        <span className="truncate text-[13px] font-semibold leading-tight">{action.title}</span>
        <span className="truncate font-mono text-[11px] tracking-[0.015em] text-muted-foreground">{action.id}</span>
      </div>
      {presets.length > 0 && (
        <span
          aria-hidden="true"
          title={t("grid.presetsCount", { count: presets.length })}
          className={`flex flex-none items-center gap-1 pr-0.5 transition-opacity duration-150 ${activeRing ? "pointer-events-none opacity-0" : ""}`}
        >
          {presets.map((p) => <i key={p.name} className="size-1 rounded-full bg-primary/40" />)}
        </span>
      )}
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
            hubIcon={action.icon}
            exiting={activeRing.exiting}
            plucking={activeRing.plucking}
            onChoose={choose}
            onHover={select}
          />
        </>
      )}
    </div>
  );
}
