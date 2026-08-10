import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { IconButton } from "./IconButton";
import { ActionIcon } from "./ActionIcon";
import { useActionRunner } from "../hooks/useActionRunner";
import type { LogcatEntry } from "../types/events";

// logcat 视图：结构化条目按 level 着色，tag 独立列，运行时可按 level/search/tag 再过滤。
// 后端按 threadtime 解析并以 JSON 下发（stream="logcat"），前端缓冲 ~5000 条环形。
// 自动滚动：贴底时跟随新条目；用户上滚暂停，显式点「回到底部」恢复。

// Android logcat 优先级顺序：V < D < I < W < E < F
const LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
// 渲染窗口：只画 filtered 末尾 RENDER_CAP 行，避免万级 DOM 拖垮帧率（缓冲/计数仍全量）。
const RENDER_CAP = 1500;
const LEVEL_RANK: Record<string, number> = {
  V: 0,
  D: 1,
  I: 2,
  W: 3,
  E: 4,
  F: 5,
};

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

// 还原为 threadtime 文本（复制用）
function entryToText(e: LogcatEntry): string {
  if (e.date === "" && e.time === "" && e.pid === 0) {
    return e.message;
  }
  return `${e.date} ${e.time} ${e.pid} ${e.tid} ${e.level} ${e.tag}: ${e.message}`;
}

export function LogcatView() {
  const { t } = useTranslation();
  const {
    actions,
    currentId,
    logcatEntries,
    logFilter,
    setLogFilter,
    clearLogcat,
    status,
    exitInfo,
    cancel,
    setView,
  } = useActionRunner();
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const current = actions.find((a) => a.id === currentId);
  const running = status === "running";

  // 运行时过滤：minLevel 阈值 + tag 子串 + message 子串
  const filtered = useMemo(() => {
    const minRank = LEVEL_RANK[logFilter.minLevel] ?? 0;
    // TAG 按空白拆分，任一子串命中即通过（与后端 allow 语义一致，支持表单多 tag 值）。
    const tags = logFilter.tag.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const search = logFilter.search.trim().toLowerCase();
    return logcatEntries.filter((e) => {
      if ((LEVEL_RANK[e.level] ?? 0) < minRank) return false;
      if (tags.length > 0) {
        const et = e.tag.toLowerCase();
        if (!tags.some((tok) => et.includes(tok))) return false;
      }
      if (search && !e.message.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [logcatEntries, logFilter.minLevel, logFilter.tag, logFilter.search]);

  // 渲染窗口：仅渲染 filtered 的最后 RENDER_CAP 行。logcat 启动常一次性倾倒整个
  // ring buffer（万级行），全量渲染会拖垮帧率；缓冲（计数/过滤）仍基于全量。
  const visible = useMemo(
    () => filtered.slice(Math.max(0, filtered.length - RENDER_CAP)),
    [filtered],
  );

  // 贴底时新条目到达自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered.length]);

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

  const onCopy = async () => {
    const text = filtered.map(entryToText).join("\n");
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

      {/* 过滤栏：level 阈值 + tag 搜索 + message 搜索 + 计数 + 清空/复制 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Select
          value={logFilter.minLevel}
          onValueChange={(v) => setLogFilter({ minLevel: String(v ?? "V") })}
        >
          <SelectTrigger size="sm" className="h-8 w-24">
            <span className="font-mono text-xs">{logFilter.minLevel}</span>
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
        <Input
          className="h-8 w-36 text-xs"
          placeholder={t("logcat.tagPlaceholder")}
          value={logFilter.tag}
          onChange={(e) => setLogFilter({ tag: e.target.value })}
        />
        <Input
          className="h-8 w-56 text-xs"
          placeholder={t("logcat.searchPlaceholder")}
          value={logFilter.search}
          onChange={(e) => setLogFilter({ search: e.target.value })}
        />
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {filtered.length}/{logcatEntries.length}
        </span>
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? t("main.copied") : t("main.copy")}
        </Button>
        <Button variant="outline" size="sm" onClick={clearLogcat}>
          {t("main.clear")}
        </Button>
      </div>

      {/* 列表：monospace，按 level 着色；贴底自动滚动。 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-auto px-3 py-2 font-mono text-xs leading-relaxed"
        >
          {filtered.length === 0 ? (
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
                <span className="w-4 shrink-0 text-center font-bold">
                  {e.level}
                </span>
                {e.tag && (
                  <span className="w-32 shrink-0 truncate text-foreground/80">
                    {e.tag}
                  </span>
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
    </main>
  );
}
