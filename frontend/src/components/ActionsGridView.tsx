import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon, FirstBracketIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY, compareGroupKeys } from "../hooks/useActionUsage";
import { missingRequired, resolveActionParams } from "../lib/params";
import { ActionIcon } from "./ActionIcon";
import { ActionPresetRing } from "./ActionPresetRing";
import { ringGeometry, ringHit, MIN_RING_BAND, type RingGeometry } from "./actionRingGeometry";
import {
  TickRuler,
  StatusRail,
  RunningFlow,
  ambFor,
  ambColorFor,
  NarrativeZone,
  PresetDots,
  PresetChips,
  GhostBtn,
  RunPill,
  QuickHint,
} from "./GridCardParts";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { Preset } from "../../bindings/workflow-tool/internal/registry/models.js";

const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

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
  const { actions, globalConfig, runAction, selectPreset, isRunning, focusRunning, openYamlEditor } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } = useActionUsage();
  const [openId, setOpenId] = useState<string | null>(null);       // 环开着（或退场中）的卡
  const [expandedId, setExpandedId] = useState<string | null>(null); // 双态：展开的卡
  const [query, setQuery] = useState("");

  const allShellActions = actions.filter((a) => !a.llm);
  // 头部搜索（FragmentsList 同款）：命中 标题 / id / 描述，小写子串
  const normalized = query.trim().toLowerCase();
  const shellActions = normalized
    ? allShellActions.filter((a) => [a.title, a.id, a.description ?? ""].join(" ").toLowerCase().includes(normalized))
    : allShellActions;
  const groups = groupByPrefix(shellActions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => compareGroupKeys(a, b));

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
        {groupEntries.map(([key, items], groupIndex) => {
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
                    group={key === MISC_KEY ? "misc" : key}
                    amb={ambColorFor(action.color) ?? ambFor(groupIndex)}
                    running={isRunning(action.id)}
                    level={footprintLevel(action.id)}
                    globalConfig={globalConfig}
                    isOpen={openId === action.id}
                    dimmed={openId !== null && openId !== action.id}
                    expanded={expandedId === action.id}
                    onOpen={() => setOpenId(action.id)}
                    onClose={() => setOpenId((current) => current === action.id ? null : current)}
                    onToggleExpand={() =>
                      setExpandedId((current) => (current === action.id ? null : action.id))
                    }
                    onCollapse={() =>
                      setExpandedId((current) => (current === action.id ? null : current))
                    }
                    onRun={(values) => { void runAction(action.id, values); }}
                    onEdit={() => selectPreset(action.id, "")}
                    onFocus={() => focusRunning(action.id, action.stream === "logcat" ? "logcat" : "output")}
                    onPresetEdit={(name) => selectPreset(action.id, name)}
                    onEditYaml={() => openYamlEditor(action.id, "action")}
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
  group: string;
  /** 氛围色（CSS 变量串，按分组显示序循环）；恒为组色，运行不夺氛围（ADR-0003） */
  amb: string;
  running: boolean;
  level: number;
  globalConfig: Record<string, string>;
  isOpen: boolean;
  dimmed: boolean;
  expanded: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToggleExpand: () => void;
  onCollapse: () => void;
  onRun: (values: Record<string, string>) => void;
  onEdit: () => void;
  onFocus: () => void;
  onPresetEdit: (name: string) => void;
  onEditYaml: () => void;
}

function ActionCard({
  action, group, amb, running, level, globalConfig, isOpen, dimmed, expanded,
  onOpen, onClose, onToggleExpand, onCollapse, onRun, onEdit, onFocus, onPresetEdit, onEditYaml,
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
  const hasParams = (action.params?.length ?? 0) > 0;
  // 氛围色恒为组色（原型 inline --amb 恒胜出的层叠语义）；运行让位只走
  // index.css 的边框/流光规则，不再整卡覆写
  const canOpen = presets.length > 0 && !running && !expanded; // 展开态不出环（chips 接管）
  // activeRing:渲染用(含退场/摘瓣动画期);liveRing:交互语义上的“环开着”
  // —— 动画期间视为已关闭:点击立即回落默认行为,选区锁定即时解除。
  const activeRing = isOpen ? ring : null;
  const liveRing = activeRing && !activeRing.exiting && activeRing.plucking === undefined ? activeRing : null;
  const isPointerRingOpen = !!liveRing && !liveRing.keyboard;

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
    // 锚点 = hub 中心；内孔直径 = hub 形变后的圆盘直径（size-10 × 1.8 = 72，
    // 与盖盘完全重合）。竖版卡高不再参与几何推导。
    const hubRect = hubRef.current.getBoundingClientRect();
    const geometry = ringGeometry(hubRect, presets.length, hubRect.height * 1.8);
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
      aria-expanded={expanded}
      aria-keyshortcuts={presets.length > 0 && !running ? "Shift+F10" : undefined}
      title={expanded ? undefined : tip || action.title}
      onClick={() => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        if (liveRing) { closeRing(); return; }
        onToggleExpand();
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
        if (event.key === "Escape" && expanded) { event.preventDefault(); onCollapse(); return; }
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggleExpand(); }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={(event) => { if (holdRef.current?.pointerId === event.pointerId) onPointerCancel(); }}
      data-running={running || undefined}
      data-expanded={expanded || undefined}
      style={{ "--amb": amb } as CSSProperties}
      className={`
        dual-card group relative flex cursor-pointer select-none flex-col rounded-lg border
        transition-[border-color,box-shadow,translate,opacity,scale] duration-150 ease-out
        ${expanded ? "col-span-2 gap-3.5 p-5" : "gap-2.5 p-3.5"}
        focus-visible:outline-none
        motion-reduce:transition-none
        ${dimmed ? "opacity-40 scale-[0.985]" : ""}
        ${activeRing
          ? // 环开态阴影提权(!)：避免被 .dual-card:hover 的 amb 内描边(同属性)覆盖
            "z-10 border-primary ring-4! ring-primary/15 shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]!"
          : "border-border"}
      `}
    >
      {running && <RunningFlow />}

      <StatusRail level={level} score={0} compact />

      {/* —— 紧凑态：身份 —— */}
      {!expanded && (
        <>
          <div className="flex min-w-0 items-start gap-2.5">
            <div
              ref={hubRef}
              data-ring-open={liveRing ? "" : undefined}
              className={`dual-hub action-hub relative grid size-10 flex-none place-items-center rounded-[27.5%]
                transition-[transform,border-radius,background-color,color,box-shadow] duration-[200ms] ${HUB_EASE} motion-reduce:transition-none
                ${activeRing
                  ? // 圆盘态用 50% 而非 rounded-full(9999px):9999px↔27.5% 插值时前段一直等效全圆，
                    // 方形度只在动画尾部瞬间恢复，收尾会“跳”一下；50%↔27.5% 则全程线性同步
                    "scale-[1.8] rounded-[50%] shadow-[0_2px_12px_rgb(0_0_0/0.3)]"
                  : // 按住时轻微收缩作预备(蓄力)，开环时从收缩位弹开成正圆盘；
                    // 圆角用百分比(40px×27.5%=11px)以便随 scale 同步放大，避免“先变大再变圆”
                    "group-active:scale-[0.96]"}`}
            >
              {/* 图标尺寸固定不变：完全由 hub 的 scale 带动，避免父级缩放与自身尺寸两条曲线叠加造成跳变 */}
              <ActionIcon name={action.icon} className="size-5" />
            </div>
            <span className="min-w-0 flex-1 pt-0.5 font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em]">
              <span className="block truncate">{action.title}</span>
              {action.description ? (
                <span className="mt-1 block truncate text-[11px] font-normal tracking-[0.015em] text-muted-foreground">
                  {action.description}
                </span>
              ) : (
                <span className="mt-1 block truncate text-[11px] font-normal tracking-[0.015em] text-muted-foreground/50">
                  {action.id}
                </span>
              )}
            </span>
            <PresetDots count={presets.length} />
          </div>
          <div className={`mt-auto flex items-center justify-end border-t border-dashed pt-2
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))]
            transition-opacity duration-150 ${activeRing ? "opacity-0" : ""}`}>
            {running ? (
              // 读数态仍可点：回到运行视图（旧「点运行中的卡回到输出」契约的紧凑态承接）
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onFocus(); }}
                className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-primary"
              >
                <span className="size-1.5 rounded-full bg-primary live-pulse" />
                {t("workflow.running")} ▸
              </button>
            ) : (
              <QuickHint label={t("grid.run")} onClick={() => activate()} />
            )}
          </div>
        </>
      )}

      {/* —— 展开态：意图 —— */}
      {expanded && (
        <>
          <div className="flex items-center gap-3">
            <span className="dual-hub flex size-10 shrink-0 items-center justify-center rounded-[27.5%]">
              <ActionIcon name={action.icon} className="size-5" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-base font-bold leading-tight -tracking-[0.01em] break-all">
                {action.title}
              </span>
              <span className="truncate font-mono text-[11px] tracking-[0.015em] text-muted-foreground">
                {group} · {action.id}
              </span>
            </span>
          </div>
          <NarrativeZone>
            {action.description || action.id}
          </NarrativeZone>
          <div className="mt-auto flex flex-wrap items-center gap-2.5 border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-3.5">
            <PresetChips
              presets={presets}
              onChoose={(name) => activate(presets.find((p) => p.name === name))}
            />
            {hasParams && (
              <GhostBtn
                label={t("grid.editForm")}
                onClick={onEdit}
                icon={<HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-3" />}
              />
            )}
            <GhostBtn
              label={t("grid.editConfig")}
              onClick={onEditYaml}
              icon={<HugeiconsIcon icon={FirstBracketIcon} strokeWidth={2} className="size-3" />}
            />
            <RunPill
              label={t("grid.run")}
              running={running}
              runningLabel={t("workflow.running")}
              onClick={() => activate()}
            />
          </div>
        </>
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
            amb={amb}
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
