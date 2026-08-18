import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  FloppyDiskIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { IconButton } from "./IconButton";
import { ActionIcon } from "./ActionIcon";
import { SavePresetDialog } from "./SavePresetDialog";
import { useActionRunner } from "../hooks/useActionRunner";
import type { LogcatEntry, LogcatToken } from "../types/events";
import {
  invalidRegex,
  parseInput,
  ruleFromParams,
  ruleToParams,
  tokenText,
} from "../lib/logcatRule";

// logcat 视图 · 两行控制甲板（spec 2026-08-18 定稿，变体 A）：
//   行 1 场景层 —— level 阈值 / pkg 只读 chip / preset 分段条 / ⟲ 重置 / matched·total 读数
//   行 2 查询控制台 —— chips 即语法（算子语义配色），草稿即时参与过滤，空格固化，
//                     chip 菜单（取反/转正则/删除），top-4 tag 快捷条
// 求值在后端（raw ring 重筛 + logcat-replace 整体重发）；本组件只编辑 logcatRule，
// Provider 300ms 防抖下发。行内 pid/tag 点击 toggle 精确条件。
// 自动滚动：贴底时跟随新条目；用户上滚暂停，显式点「回到底部」恢复。

// Android logcat 优先级顺序：V < D < I < W < E < F
const LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
// 渲染窗口：只画末尾 RENDER_CAP 行，避免万级 DOM 拖垮帧率（缓冲/计数仍全量，后端 ring 10k）。
const RENDER_CAP = 1500;

// 每个等级的文本色（badge + 整行）
function levelColor(level: string): string {
  switch (level) {
    case "V":
      return "text-muted-foreground";
    case "D":
      return "text-sky-500";
    case "I":
      return "text-emerald-500";
    case "W":
      return "text-amber-500";
    case "E":
      return "text-red-500";
    case "F":
      return "text-red-500 font-bold";
    default:
      return "text-muted-foreground";
  }
}

// 算子语义配色（spec 签名元素）：取反=destructive / 精确=success / 正则=chart-4 / 子串=muted
function opText(t: LogcatToken): string {
  if (t.negated) return "text-destructive";
  if (t.op === "exact") return "text-success";
  if (t.op === "regex") return "text-chart-4";
  return "text-muted-foreground/70";
}

// 还原为 threadtime 文本（复制用）
function entryToText(e: LogcatEntry): string {
  if (e.date === "" && e.time === "" && e.pid === 0) {
    return e.message;
  }
  return `${e.date} ${e.time} ${e.pid} ${e.tid} ${e.level} ${e.tag}: ${e.message}`;
}

// 固化 chip：文本即语法，点击开菜单，× 删除
function Chip({
  tok,
  onMenu,
  onRemove,
  menuTitle,
  removeLabel,
}: {
  tok: LogcatToken;
  onMenu: () => void;
  onRemove: () => void;
  menuTitle: string;
  removeLabel: string;
}) {
  return (
    <span
      className={`inline-flex max-w-64 items-center gap-0.5 rounded border bg-secondary/60 px-1.5 py-0.5 ${
        tok.draft ? "border-dashed border-border opacity-80" : "border-border"
      }`}
    >
      <button
        type="button"
        className="font-mono hover:opacity-80"
        onClick={onMenu}
        title={menuTitle}
      >
        {tok.negated && <span className="text-destructive">−</span>}
        {tok.key !== "any" && (
          <span className="text-muted-foreground">{tok.key}</span>
        )}
        <span className={opText(tok)}>
          {tok.op === "exact" ? "=:" : tok.op === "regex" ? "~:" : ":"}
        </span>
        <span className="max-w-40 truncate text-foreground">{tok.value}</span>
      </button>
      <button
        type="button"
        aria-label={removeLabel}
        className="ml-0.5 text-muted-foreground/60 hover:text-destructive"
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

export function LogcatView() {
  const { t } = useTranslation();
  const {
    actions,
    currentId,
    logcatEntries,
    logcatRule,
    setLogcatRule,
    logcatStats,
    logcatTagHist,
    logcatReplaceSeq,
    clearLogcat,
    status,
    exitInfo,
    cancel,
    setView,
    lastRunParams,
  } = useActionRunner();
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState(""); // 控制台未固化文本（草稿）
  const [menuIdx, setMenuIdx] = useState<number | null>(null); // 打开菜单的 chip（committed 索引）
  const [regexErr, setRegexErr] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false); // 存为预设弹窗

  // 存为预设的参数集：lastRunParams 保留非规则参数（设备等），规则键剥离后由
  // ruleToParams(logcatRule) 重写（FILTER 权威 + 可无损表达的 legacy 键）。
  const presetValues = useMemo(() => {
    const rest = { ...(lastRunParams[currentId ?? ""] ?? {}) };
    for (const k of ["LEVEL", "TAG", "INCLUDE", "EXCLUDE", "PACKAGE", "FILTER"])
      delete rest[k];
    return { ...rest, ...ruleToParams(logcatRule) };
  }, [lastRunParams, currentId, logcatRule]);

  const current = actions.find((a) => a.id === currentId);
  const running = status === "running";

  // 固化 chips = 规则里非草稿 token；草稿尾巴由 input 文本派生并即时并入规则。
  const committed = useMemo(
    () => logcatRule.tokens.filter((tk) => !tk.draft),
    [logcatRule],
  );
  const setTokens = (next: LogcatToken[]) =>
    setLogcatRule({ ...logcatRule, tokens: next });

  // 渲染窗口：仅渲染末尾 RENDER_CAP 行（过滤在后端完成，entries 已是命中集）。
  const visible = useMemo(
    () => logcatEntries.slice(Math.max(0, logcatEntries.length - RENDER_CAP)),
    [logcatEntries],
  );

  // 读数：重放帧带回 matched/total（首次运行尚无重放时退化为本地条数，语义等价——
  // entries 即后端当前规则的命中集）。0 命中高亮 destructive。
  const hasStats = logcatStats.total > 0;
  const zero = hasStats && logcatStats.matched === 0;

  // 贴底时新条目到达自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [logcatEntries.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  // ——— 控制台编辑 ———

  // 草稿即时并入规则（末段 parseInput 标 draft，后端不区分，仅 chip 虚框展示用）
  const onInputChange = (v: string) => {
    setInput(v);
    const drafts = parseInput(v).filter((tk) => tk.value);
    setLogcatRule({ ...logcatRule, tokens: [...committed, ...drafts] });
    if (!drafts.some((tk) => tk.op === "regex" && invalidRegex(tk.value)))
      setRegexErr("");
  };

  // 固化：Enter/Tab/空格触发；正则 token 非法时拒绝并提示（后端 CompileRule 是最终防线）
  const commitInput = () => {
    const toks = parseInput(input).filter((tk) => tk.value);
    const bad = toks.find((tk) => tk.op === "regex" && invalidRegex(tk.value));
    if (bad) {
      setRegexErr(t("logcat.regexError", { value: bad.value }));
      return;
    }
    setRegexErr("");
    if (toks.length)
      setTokens([...committed, ...toks.map((tk) => ({ ...tk, draft: false }))]);
    setInput("");
  };

  // 行内 pid/tag 与快捷条共用的 toggle：按可复制文本去重
  const toggleToken = (tok: LogcatToken) => {
    const text = tokenText(tok);
    const i = committed.findIndex((c) => tokenText(c) === text);
    if (i >= 0) setTokens(committed.filter((_, j) => j !== i));
    else setTokens([...committed, tok]);
  };
  const tokenActive = (tok: LogcatToken) =>
    committed.some((c) => tokenText(c) === tokenText(tok));

  // chip 菜单：取反 / 转正则 / 删除
  const menuAction = (i: number, kind: "negate" | "regex" | "delete") => {
    const tk = committed[i];
    if (!tk) return;
    if (kind === "delete") {
      setTokens(committed.filter((_, j) => j !== i));
    } else if (kind === "negate") {
      setTokens(
        committed.map((c, j) => (j === i ? { ...c, negated: !c.negated } : c)),
      );
    } else {
      if (invalidRegex(tk.value)) {
        setRegexErr(t("logcat.regexError", { value: tk.value }));
        return;
      }
      setTokens(committed.map((c, j) => (j === i ? { ...c, op: "regex" } : c)));
    }
    setMenuIdx(null);
  };

  // preset 整体替换规则（spec：preset 即完整场景）；⟲ 重置回全量
  const applyPreset = (values: Record<string, unknown>) => {
    setInput("");
    setMenuIdx(null);
    setRegexErr("");
    setLogcatRule(ruleFromParams(values));
  };
  const resetRule = () => {
    setInput("");
    setMenuIdx(null);
    setRegexErr("");
    setLogcatRule({ tokens: [], minLevel: "V", package: "" });
  };

  const onCopy = async () => {
    const text = logcatEntries.map(entryToText).join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const statusNode = running ? (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary">
      <span className="size-1.5 rounded-full bg-primary live-pulse" />
      {t("workflow.running")}
    </span>
  ) : exitInfo && current ? (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-xs ${
        exitInfo.exitCode === 0 ? "text-success" : "text-destructive"
      }`}
    >
      {exitInfo.exitCode === 0 ? t("workflow.done") : t("workflow.error")}
      {exitInfo.duration && (
        <span className="text-muted-foreground">· {exitInfo.duration}</span>
      )}
    </span>
  ) : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <IconButton
            icon={ArrowLeft01Icon}
            label={t("sidebar.allActions")}
            onClick={() => setView("actions-grid")}
          />
          {current && (
            <span className="flex items-center gap-1.5 rounded px-1 font-semibold">
              <ActionIcon name={current.icon ?? "hi:play"} />
              {current.title}
            </span>
          )}
          {statusNode}
        </div>
        {running && (
          <Button variant="destructive" size="sm" onClick={cancel}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
            {t("main.stop")}
          </Button>
        )}
      </header>

      {/* ——— 行 1 · 场景层：level / pkg / presets / ⟲ 重置 / 读数 / 复制·清空 ——— */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Select
          value={logcatRule.minLevel}
          onValueChange={(v) =>
            setLogcatRule({ ...logcatRule, minLevel: String(v ?? "V") })
          }
        >
          <SelectTrigger size="sm" className="h-8 w-24">
            <span className="font-mono text-xs">{logcatRule.minLevel}</span>
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((lv) => (
              <SelectItem key={lv} value={lv}>
                <span className={`font-mono ${levelColor(lv)}`}>
                  {lv} · {t(`logcat.level.${lv}`)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {logcatRule.package && (
          <span className="inline-flex items-center gap-1 rounded border border-dashed border-border bg-secondary/40 px-1.5 py-1 font-mono text-xs">
            <span className="text-muted-foreground">pkg</span>
            <span className="text-muted-foreground/70">:</span>
            <span className="max-w-44 truncate" title={logcatRule.package}>
              {logcatRule.package}
            </span>
            <button
              type="button"
              aria-label={t("logcat.removePackage")}
              title={t("logcat.removePackage")}
              className="text-muted-foreground/60 hover:text-destructive"
              onClick={() => setLogcatRule({ ...logcatRule, package: "" })}
            >
              ×
            </button>
          </span>
        )}
        <span className="flex items-center gap-0.5">
          {current?.presets?.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => applyPreset(p.values)}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
            >
              <span className="size-[5px] rounded-full bg-primary/45" />
              {p.name}
            </button>
          ))}
          <button
            type="button"
            onClick={resetRule}
            title={t("logcat.reset")}
            className="ml-1 h-8 rounded-md px-2 font-mono text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            ⟲ {t("logcat.reset")}
          </button>
          {/* 存为预设：甲板当前规则（含 regex/pid/取反）落盘为 preset */}
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            title={t("logcat.savePreset")}
            className="h-8 rounded-md px-2 font-mono text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <HugeiconsIcon
              icon={FloppyDiskIcon}
              strokeWidth={1.75}
              className="mr-1 inline size-3.5"
            />
            {t("logcat.savePreset")}
          </button>
        </span>
        {/* matched/total 读数：重放帧更新时脉冲一下；0 命中转 destructive */}
        {hasStats ? (
          <span
            key={logcatReplaceSeq}
            title={`${t("logcat.statMatched")} / ${t("logcat.statTotal")}`}
            className={`ml-auto font-mono text-xs tabular-nums ${
              zero ? "text-destructive" : "text-muted-foreground"
            } ${logcatReplaceSeq > 0 ? "animate-[pulse_0.24s_ease-out_1]" : ""}`}
          >
            {logcatStats.matched}/{logcatStats.total}
          </span>
        ) : (
          <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
            {logcatEntries.length}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? t("main.copied") : t("main.copy")}
        </Button>
        <Button variant="outline" size="sm" onClick={clearLogcat}>
          {t("main.clear")}
        </Button>
      </div>

      {/* ——— 行 2 · 查询控制台（签名元素）：chips + 草稿输入 + top-4 快捷条 ——— */}
      <div className="relative flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b bg-secondary/20 px-3 py-1.5 font-mono text-xs">
        {committed.map((tok, i) => (
          <Chip
            key={`${tokenText(tok)}#${i}`}
            tok={tok}
            menuTitle={t("logcat.chipMenuTitle")}
            removeLabel={t("logcat.chipMenu.delete")}
            onMenu={() => setMenuIdx(menuIdx === i ? null : i)}
            onRemove={() => {
              setTokens(committed.filter((_, j) => j !== i));
              setMenuIdx(null);
            }}
          />
        ))}
        {menuIdx !== null && committed[menuIdx] && (
          <span className="absolute left-3 top-full z-20 mt-1 flex overflow-hidden rounded-md border bg-popover text-xs shadow-md">
            {(
              [
                ["negate", t("logcat.chipMenu.negate")],
                ["regex", t("logcat.chipMenu.toRegex")],
                ["delete", t("logcat.chipMenu.delete")],
              ] as Array<["negate" | "regex" | "delete", string]>
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                className="px-2.5 py-1 hover:bg-primary/10 hover:text-primary"
                onClick={() => menuAction(menuIdx, kind)}
              >
                {label}
              </button>
            ))}
          </span>
        )}
        <span className="flex min-w-40 flex-1 items-center">
          <input
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                commitInput();
              } else if (e.key === " " && input.trim()) {
                // 空格固化当前段（多段粘贴也按段全部固化）
                e.preventDefault();
                commitInput();
              } else if (e.key === "Backspace" && !input && committed.length) {
                setTokens(committed.slice(0, -1));
              } else if (e.key === "Escape") {
                setMenuIdx(null);
              }
            }}
            placeholder={
              committed.length === 0 && !input
                ? t("logcat.consolePlaceholder")
                : ""
            }
            className={`w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/40 ${
              regexErr ? "text-destructive" : ""
            }`}
          />
        </span>
        {/* top-4 tag 快捷条（重放帧直方图）：点击 toggle 精确 tag */}
        <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {logcatTagHist.slice(0, 4).map(([tag, n]) => (
            <button
              key={tag}
              type="button"
              onClick={() =>
                toggleToken({ key: "tag", op: "exact", negated: false, value: tag })
              }
              className={`flex items-center gap-1 hover:text-primary ${
                tokenActive({
                  key: "tag",
                  op: "exact",
                  negated: false,
                  value: tag,
                })
                  ? "text-primary"
                  : ""
              }`}
              title={t("logcat.quickTag")}
            >
              {tag}
              <span className="tabular-nums opacity-60">{n}</span>
            </button>
          ))}
        </span>
        {regexErr && (
          <span className="absolute bottom-full right-3 mb-1 rounded bg-destructive px-1.5 py-0.5 text-[10px] text-white">
            {regexErr}
          </span>
        )}
      </div>

      {/* ——— 日志区：后端已过滤的命中集；行内 pid/tag 点击 toggle ——— */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-auto px-3 py-2 font-mono text-xs leading-relaxed"
        >
          {zero ? (
            <div className="flex flex-col items-center gap-1 py-8 text-center">
              <span className="font-mono text-xs text-destructive">
                {t("logcat.zeroMatch")}
              </span>
              <span className="text-muted-foreground">
                {t("logcat.zeroHint")}
              </span>
            </div>
          ) : logcatEntries.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {t("logcat.empty")}
            </div>
          ) : (
            visible.map((e, i) => (
              <div
                key={i}
                className={`flex gap-2 whitespace-pre-wrap break-all ${levelColor(
                  e.level,
                )}`}
              >
                {e.time && (
                  <span className="shrink-0 text-muted-foreground">{e.time}</span>
                )}
                {e.pid > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      toggleToken({
                        key: "pid",
                        op: "exact",
                        negated: false,
                        value: String(e.pid),
                      })
                    }
                    className={`shrink-0 tabular-nums underline-offset-2 hover:underline ${
                      tokenActive({
                        key: "pid",
                        op: "exact",
                        negated: false,
                        value: String(e.pid),
                      })
                        ? "text-primary"
                        : "text-muted-foreground/50"
                    }`}
                    title={t("logcat.onlyThisProcess")}
                  >
                    {e.pid}
                  </button>
                )}
                <span className="w-4 shrink-0 text-center font-bold">
                  {e.level}
                </span>
                {e.tag && (
                  <button
                    type="button"
                    onClick={() =>
                      toggleToken({
                        key: "tag",
                        op: "exact",
                        negated: false,
                        value: e.tag,
                      })
                    }
                    className={`w-36 shrink-0 truncate text-left underline-offset-2 hover:underline ${
                      tokenActive({
                        key: "tag",
                        op: "exact",
                        negated: false,
                        value: e.tag,
                      })
                        ? "text-primary"
                        : "text-foreground/80"
                    }`}
                    title={t("logcat.onlyThisTag")}
                  >
                    {e.tag}
                  </button>
                )}
                <span className="min-w-0 flex-1">{e.message}</span>
              </div>
            ))
          )}
        </div>
        {/* 离底时显示「回到底部」悬浮按钮 */}
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs shadow-md hover:bg-accent"
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={1.75}
              className="size-3.5"
            />
            {t("logcat.scrollBottom")}
          </button>
        )}
      </div>
      <SavePresetDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        values={presetValues}
      />
    </main>
  );
}
