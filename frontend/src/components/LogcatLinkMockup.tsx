import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type { LogcatEntry, LogcatToken } from "../types/events";
import { invalidRegex, parseInput } from "../lib/logcatRule";

/**
 * logcat 连接符（link / 条件组）机制设计稿（dev 专用，经 ?mockup=logcat-link 进入）。
 *
 * 语义（与 Go CompileRule 规划一致，此处内置迷你求值器做实机演示）：
 *   - 条件组渲染为主题色虚线框（本稿签名元素）；组间 ∨ 分隔，任一组命中即通过；
 *   - 组内 ∧ 同时满足（跨 key AND）；同 key 并入 = 桶内任一命中（tooltip 说明）；
 *   - 取反 chip 全局排除，不参与分组，裸渲染在框外；
 *   - 无任何 ∨ 的规则 = 单组 = 现行为（向后兼容）。
 *
 * 编辑入口：① 点连接符 toggle ∧⇄∨；② chip 菜单「∨ 另起一组 / ∧ 并入前组」。
 * 底部实时展示 FILTER JSON（preset 落盘 payload），验证序列化往返。
 */

const LEVELS = ["V", "D", "I", "W", "E", "F"] as const;

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

function opText(t: LogcatToken): string {
  if (t.negated) return "text-destructive";
  if (t.op === "exact") return "text-success";
  if (t.op === "regex") return "text-chart-4";
  return "text-muted-foreground/70";
}

function rank(level: string): number {
  return "VDIWEF".indexOf(level.toUpperCase());
}

// ——— 迷你求值器（镜像后端 combo 语义；真实现仍在 Go，勿复用于生产组件） ———

function tokenHit(t: LogcatToken, e: LogcatEntry): boolean {
  switch (t.key) {
    case "pid":
      return String(e.pid) === t.value;
    case "tid":
      return String(e.tid) === t.value;
    case "tag":
      return textHit(t, e.tag);
    case "message":
      return textHit(t, e.message);
    default: {
      if (t.key === "any") {
        return textHit(t, e.tag) || textHit(t, e.message);
      }
      return false;
    }
  }
}

function textHit(t: LogcatToken, s: string): boolean {
  if (t.op === "exact") return s === t.value;
  if (t.op === "regex") {
    try {
      return new RegExp(t.value).test(s);
    } catch {
      return false;
    }
  }
  return s.toLowerCase().includes(t.value.toLowerCase());
}

function makeMatcher(tokens: LogcatToken[], minLevel: string) {
  const live = tokens.filter((t) => t.value);
  const neg = live.filter((t) => t.negated);
  const pos = live.filter((t) => !t.negated);
  // 按 link=or 切组（首个正向 token 的 link 忽略）
  const groups: LogcatToken[][] = [];
  for (const t of pos) {
    if (t.link === "or" && groups.length > 0) groups.push([t]);
    else if (groups.length === 0) groups.push([t]);
    else groups[groups.length - 1].push(t);
  }
  return (e: LogcatEntry): boolean => {
    if (rank(e.level) < rank(minLevel)) return false;
    for (const n of neg) if (tokenHit(n, e)) return false;
    if (groups.length === 0) return true;
    return groups.some((g) => {
      // 组内按 key 分桶：每桶至少一个命中（同 key OR、跨 key AND）
      const buckets = new Map<string, LogcatToken[]>();
      for (const t of g) {
        const arr = buckets.get(t.key) ?? [];
        arr.push(t);
        buckets.set(t.key, arr);
      }
      return [...buckets.values()].every((arr) => arr.some((t) => tokenHit(t, e)));
    });
  };
}


// ——— mock 数据（threadtime 字段展开；tags 覆盖 4 个场景的命中面） ———

const E = (
  time: string,
  pid: number,
  tid: number,
  level: string,
  tag: string,
  message: string,
): LogcatEntry => ({ date: "08-19", time, pid, tid, level, tag, message });

const MOCK_ENTRIES: LogcatEntry[] = [
  E("11:22:33.102", 897, 912, "I", "ActivityTaskManager", "Start proc 3311:com.android.webview for activity"),
  E("11:22:33.180", 612, 615, "I", "SurfaceFlinger", "Layer: layer update stats frameCounter 8812"),
  E("11:22:33.204", 897, 903, "I", "ActivityTaskManager", "Displayed com.example.app/.MainActivity"),
  E("11:22:33.318", 1520, 1531, "I", "NavigationBarController", "navigation mode changed to GESTURAL"),
  E("11:22:33.402", 1520, 1544, "D", "NavigationBar", "relayout finished in 12ms"),
  E("11:22:33.471", 947, 950, "I", "AudioFlinger", "AudioTrack: track start session 128"),
  E("11:22:33.530", 3311, 3320, "I", "chromium", "[INFO:aw_contents.cc(210)] cranked rendering path"),
  E("11:22:33.612", 1520, 1531, "D", "CentralSurfaces", "nav bar relayout requested"),
  E("11:22:33.688", 612, 617, "W", "EventThread", "vsync tick drift 1.8ms"),
  E("11:22:33.741", 1520, 1560, "W", "AndroidInputDispatcher", "input event dispatch latency: 42ms over threshold"),
  E("11:22:33.802", 947, 952, "D", "FastMixer", "track stopped, underruns 0"),
  E("11:22:33.860", 3311, 3325, "E", "chromium", "[ERROR:render_frame_host.cc(489)] rendering error, retrying frame"),
  E("11:22:33.915", 1520, 1544, "D", "NavigationBar", "nav bar icons alpha updated"),
  E("11:22:33.978", 897, 915, "W", "ActivityManager", "Unable to start service, not found"),
  E("11:22:34.021", 612, 615, "E", "BufferQueueLayer", "error committing buffer, fence timed out"),
  E("11:22:34.090", 1520, 1571, "I", "WindowManagerDimLayer", "window focus changed to com.android.systemui"),
  E("11:22:34.142", 947, 950, "I", "AudioFlinger", "offload output enabled for stream music"),
  E("11:22:34.188", 3311, 3331, "I", "cr_Console", "page loaded in 842ms"),
  E("11:22:34.231", 612, 619, "I", "SurfaceFlinger", "rebooted composer vsync model"),
  E("11:22:34.302", 1520, 1531, "D", "PointerIcon", "input device added"),
  E("11:22:34.356", 947, 961, "W", "AudioTrack", "track start latency 18ms"),
  E("11:22:34.401", 3311, 3320, "W", "cr_media", "media pipeline stalled waiting for decoder"),
  E("11:22:34.460", 612, 621, "D", "LayerLifecycle", "layer handle removed"),
  E("11:22:34.512", 1520, 1544, "I", "CentralSurfaces", "nav bar scrim applied for dark theme"),
  E("11:22:34.578", 947, 952, "D", "AudioPolicyService", "audio focus request logged"),
  E("11:22:34.620", 3311, 3331, "I", "chromium", "[INFO:web_view.cc(120)] window resized to 1280x720"),
  E("11:22:34.684", 0, 0, "W", "thermal_core", "thermal zone trip point crossed"),
  E("11:22:34.731", 947, 950, "I", "AudioFlinger", "AudioTrack: track start session 129 for alarm"),
  E("11:22:34.790", 1520, 1560, "W", "AndroidInputDispatcher", "input channel consumed, anr watch armed"),
  E("11:22:34.842", 612, 615, "I", "SurfaceFlinger", "layer update stats committed in 3.2ms"),
  E("11:22:34.901", 3311, 3325, "E", "crashpad", "minidump written: /data/tmp/webview.dmp"),
  E("11:22:34.955", 1520, 1571, "I", "WindowManagerDimLayer", "window inset controller persisted"),
  E("11:22:35.012", 947, 961, "D", "FastMixer", "track stopped, underruns 2"),
  E("11:22:35.068", 0, 0, "I", "binder", "transaction allocated 4096 bytes"),
  E("11:22:35.121", 1520, 1544, "D", "NavigationBar", "gesture handle tint refreshed"),
  E("11:22:35.180", 612, 617, "V", "EventThread", "vsync subsystem idle"),
];

const tk = (
  key: LogcatToken["key"],
  value: string,
  extra?: Partial<LogcatToken>,
): LogcatToken => ({ key, op: "contains", negated: false, value, ...extra });

// 场景：一键装载规则，覆盖四个语义面
const SCENARIOS: Array<{ name: string; tokens: LogcatToken[]; minLevel: string }> = [
  {
    name: "组合",
    tokens: [tk("tag", "SystemUI"), tk("message", "nav")],
    minLevel: "V",
  },
  {
    name: "双组合任选",
    tokens: [
      tk("tag", "SystemUI"),
      tk("message", "nav"),
      tk("tag", "AudioFlinger", { link: "or" }),
      tk("message", "track"),
    ],
    minLevel: "V",
  },
  {
    name: "同key任一+组合",
    tokens: [
      tk("tag", "SurfaceFlinger"),
      tk("tag", "chromium"),
      tk("message", "error"),
    ],
    minLevel: "V",
  },
  {
    name: "取反+组合",
    tokens: [
      tk("tag", "DimLayer"),
      tk("message", "window"),
      tk("message", "input", { negated: true }),
    ],
    minLevel: "D",
  },
];

// FILTER JSON（preset payload 预览：and/空 link 省略，仅 or 写出）
function filterJson(tokens: LogcatToken[], minLevel: string): string {
  const live = tokens.filter((t) => t.value);
  if (!live.length && minLevel === "V") return "（空规则不写 FILTER）";
  return JSON.stringify({
    tokens: live.map((t) => ({
      key: t.key,
      op: t.op,
      negated: t.negated,
      value: t.value,
      ...(t.link === "or" ? { link: "or" } : {}),
    })),
    minLevel,
    package: "",
  });
}

// 连接符：语法字形而非按钮壳——组内 ∧ 弱到标点级；组间 ∨ 主色加粗（框外分隔条件组）。
// 与后继 chip/框同 wrapper，换行不落单。sameKey 仅影响 ∧ 的 tooltip 说明（同 key 并入=任一命中）。
function Connective({
  kind,
  sameKey,
  onToggle,
}: {
  kind: "and" | "or";
  sameKey?: boolean;
  onToggle: () => void;
}) {
  const title =
    kind === "or"
      ? "∨ 另起条件组（任一组命中即通过）· 点击并为 ∧ 并入前组"
      : sameKey
        ? "∧ 并入当前组（同 key 并入 = 任一命中）· 点击另起条件组"
        : "∧ 并入当前组同时满足 · 点击改为 ∨ 另起条件组";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      className={`select-none px-0.5 text-[10px] leading-none underline-offset-2 hover:underline ${
        kind === "or"
          ? "font-bold text-primary hover:opacity-80"
          : "text-muted-foreground/40 hover:text-primary/80"
      }`}
    >
      {kind === "and" ? "∧" : "∨"}
    </button>
  );
}

function MockChip({
  tok,
  menuOpen,
  onMenu,
  onMenuAction,
  onRemove,
  linkLabel,
}: {
  tok: LogcatToken;
  menuOpen: boolean;
  onMenu: () => void;
  onMenuAction: (kind: "negate" | "regex" | "link" | "delete") => void;
  onRemove: () => void;
  linkLabel?: string;
}) {
  const items: Array<{ kind: "negate" | "regex" | "link" | "delete"; label: string }> = [
    { kind: "negate", label: "取反" },
    { kind: "regex", label: "转正则" },
    ...(linkLabel ? [{ kind: "link" as const, label: linkLabel }] : []),
    { kind: "delete", label: "删除" },
  ];
  return (
    <span className="relative inline-flex">
      <span
        className={`inline-flex max-w-64 items-center gap-0.5 rounded border bg-secondary/60 px-1.5 py-0.5 ${
          tok.draft ? "border-dashed border-border opacity-80" : "border-border"
        }`}
      >
        <button
          type="button"
          className="font-mono hover:opacity-80"
          onClick={onMenu}
          title="点击：取反 / 转正则 / 分组 / 删除"
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
          aria-label="删除"
          className="ml-0.5 font-mono text-muted-foreground/60 hover:text-destructive"
          onClick={onRemove}
        >
          ×
        </button>
      </span>
      {menuOpen && (
        <span className="absolute left-0 top-full z-20 mt-1 flex overflow-hidden rounded-md border bg-popover text-xs shadow-md">
          {items.map((it) => (
            <button
              key={it.kind}
              type="button"
              className={`px-2.5 py-1 hover:bg-primary/10 hover:text-primary ${
                it.kind === "link" ? "font-semibold text-primary hover:opacity-80" : ""
              }`}
              onClick={() => onMenuAction(it.kind)}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function LogcatLinkMockup() {
  const [dark, setDark] = useState(true);
  const [scenario, setScenario] = useState(1);
  const [tokens, setTokens] = useState<LogcatToken[]>(SCENARIOS[1].tokens.map((t) => ({ ...t })));
  const [minLevel, setMinLevel] = useState(SCENARIOS[1].minLevel);
  const [input, setInput] = useState("");
  const [menuIdx, setMenuIdx] = useState<number | null>(null);
  const [regexErr, setRegexErr] = useState("");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const committed = useMemo(() => tokens.filter((t) => !t.draft), [tokens]);
  const setCommitted = (next: LogcatToken[]) =>
    setTokens([...next, ...tokens.filter((t) => t.draft)]);

  const matcher = useMemo(() => makeMatcher(tokens, minLevel), [tokens, minLevel]);
  const matched = useMemo(() => MOCK_ENTRIES.filter(matcher), [matcher]);
  const json = filterJson(tokens, minLevel);

  const loadScenario = (i: number) => {
    setScenario(i);
    setTokens(SCENARIOS[i].tokens.map((t) => ({ ...t })));
    setMinLevel(SCENARIOS[i].minLevel);
    setInput("");
    setMenuIdx(null);
    setRegexErr("");
  };

  const onInputChange = (v: string) => {
    setInput(v);
    const drafts = parseInput(v).filter((t) => t.value);
    setTokens([...committed, ...drafts]);
    if (!drafts.some((t) => t.op === "regex" && invalidRegex(t.value)))
      setRegexErr("");
  };

  const commitInput = () => {
    const toks = parseInput(input).filter((t) => t.value);
    const bad = toks.find((t) => t.op === "regex" && invalidRegex(t.value));
    if (bad) {
      setRegexErr(`非法正则: ${bad.value}`);
      return;
    }
    setRegexErr("");
    if (toks.length)
      setCommitted([...committed, ...toks.map((t) => ({ ...t, draft: false }))]);
    setInput("");
  };

  // 连接符 toggle：∧⇄∨（改的是该 token 的 link）
  const toggleLink = (i: number) => {
    setTokens(tokens.map((t, j) => (j === i ? { ...t, link: t.link === "or" ? "and" : "or" } : t)));
  };

  const menuAction = (i: number, kind: "negate" | "regex" | "link" | "delete") => {
    const t = committed[i];
    if (!t) return;
    if (kind === "delete") {
      setCommitted(committed.filter((_, j) => j !== i));
    } else if (kind === "negate") {
      setCommitted(committed.map((c, j) => (j === i ? { ...c, negated: !c.negated } : c)));
    } else if (kind === "link") {
      setCommitted(
        committed.map((c, j) => (j === i ? { ...c, link: c.link === "or" ? "and" : "or" } : c)),
      );
    } else {
      if (invalidRegex(t.value)) {
        setRegexErr(`非法正则: ${t.value}`);
        return;
      }
      setCommitted(committed.map((c, j) => (j === i ? { ...c, op: "regex" } : c)));
    }
    setMenuIdx(null);
  };

  const linkLabelFor = (ci: number): string | undefined => {
    const t = committed[ci];
    if (!t || t.negated) return undefined;
    const hasPrev = committed.some((p, j) => j < ci && p.value && !p.negated);
    if (!hasPrev) return undefined;
    return t.link === "or" ? "∧ 并入前组" : "∨ 另起一组";
  };

  // 分段渲染：正向 token 按 link=or 切组（虚线框 = 条件组）；取反 chip 全局裸渲染在框外。
  // 无 link 的正向 token 归入最近一个组（跨过取反 chip），草稿随尾组。
  const segs = useMemo(() => {
    const segs: Array<
      | { kind: "neg"; tok: LogcatToken; ti: number }
      | { kind: "group"; items: Array<{ tok: LogcatToken; ti: number }> }
    > = [];
    tokens.forEach((tok, ti) => {
      if (!tok.value) return;
      if (tok.negated) {
        segs.push({ kind: "neg", tok, ti });
        return;
      }
      if (tok.link === "or" && segs.some((s) => s.kind === "group")) {
        segs.push({ kind: "group", items: [{ tok, ti }] });
        return;
      }
      for (let k = segs.length - 1; k >= 0; k--) {
        const s = segs[k];
        if (s.kind === "group") {
          s.items.push({ tok, ti });
          return;
        }
      }
      segs.push({ kind: "group", items: [{ tok, ti }] });
    });
    return segs;
  }, [tokens]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* 工具条：场景 / 读数 / 深浅 */}
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          logcat · link 机制 Mockup
        </span>
        <span className="flex items-center gap-0.5">
          {SCENARIOS.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => loadScenario(i)}
              className={`flex h-7 items-center gap-1.5 rounded-md px-2 font-mono text-xs ${
                scenario === i
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
            >
              <span className="size-[5px] rounded-full bg-primary/45" />
              {s.name}
            </button>
          ))}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {matched.length}/{MOCK_ENTRIES.length}
        </span>
        <span className="ms-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDark((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
          >
            <HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} strokeWidth={1.75} className="size-3.5" />
            {dark ? "浅色" : "深色"}
          </button>
        </span>
      </header>

      {/* 行 1 · 场景层（真实视图比例上下文）：level + 语义图例 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
        <Select value={minLevel} onValueChange={(v) => setMinLevel(String(v ?? "V"))}>
          <SelectTrigger size="sm" className="h-8 w-24">
            <span className="font-mono text-xs">{minLevel}</span>
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((lv) => (
              <SelectItem key={lv} value={lv}>
                <span className={`font-mono ${levelColor(lv)}`}>{lv}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[10px] text-muted-foreground/70">
          语义：虚线框 = 条件组 · 组间 ∨ 任一组命中即通过 · 组内 ∧ 同时满足（同 key 并入 = 任一命中）· 取反全局排除（框外）
        </span>
      </div>

      {/* 行 2 · 查询控制台（本稿主角）：虚线框 = 条件组，chips 为项、连接符为算子 */}
      <div className="relative flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b bg-secondary/20 px-3 py-1.5 font-mono text-xs">
        {segs.map((seg, si) => {
          if (seg.kind === "neg") {
            const ci = committed.indexOf(seg.tok);
            return (
              <MockChip
                key={`neg#${seg.ti}`}
                tok={seg.tok}
                menuOpen={menuIdx !== null && menuIdx === ci}
                onMenu={() => setMenuIdx(menuIdx === ci ? null : ci)}
                onMenuAction={(kind) => {
                  if (ci >= 0) menuAction(ci, kind);
                }}
                onRemove={() => {
                  if (ci >= 0) {
                    setCommitted(committed.filter((_, j) => j !== ci));
                    setMenuIdx(null);
                  }
                }}
              />
            );
          }
          const prevGroup = segs.slice(0, si).some((s) => s.kind === "group");
          return (
            <span
              key={`grp#${seg.items[0].ti}`}
              className="inline-flex items-center gap-1.5"
            >
              {prevGroup && (
                <Connective kind="or" onToggle={() => toggleLink(seg.items[0].ti)} />
              )}
              {/* 条件组：主题色虚线框（签名元素）；框内 chips 组内 ∧ 分隔 */}
              <span className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-dashed border-primary/50 bg-primary/[0.04] px-1 py-1">
                {seg.items.map(({ tok, ti }, k) => {
                  const ci = committed.indexOf(tok);
                  const sameKey =
                    k > 0 && seg.items.slice(0, k).some((p) => p.tok.key === tok.key);
                  return (
                    <span key={ti} className="inline-flex items-center gap-1">
                      {k > 0 && (
                        <Connective
                          kind="and"
                          sameKey={sameKey}
                          onToggle={() => toggleLink(ti)}
                        />
                      )}
                      <MockChip
                        tok={tok}
                        menuOpen={menuIdx !== null && menuIdx === ci}
                        linkLabel={ci >= 0 ? linkLabelFor(ci) : undefined}
                        onMenu={() => setMenuIdx(menuIdx === ci ? null : ci)}
                        onMenuAction={(kind) => {
                          if (ci >= 0) menuAction(ci, kind);
                        }}
                        onRemove={() => {
                          if (ci >= 0) {
                            setCommitted(committed.filter((_, j) => j !== ci));
                            setMenuIdx(null);
                          }
                        }}
                      />
                    </span>
                  );
                })}
              </span>
            </span>
          );
        })}
        <span className="flex min-w-40 flex-1 items-center">
          <input
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                commitInput();
              } else if (e.key === " " && input.trim()) {
                e.preventDefault();
                commitInput();
              } else if (e.key === "Backspace" && !input && committed.length) {
                setCommitted(committed.slice(0, -1));
              } else if (e.key === "Escape") {
                setMenuIdx(null);
              }
            }}
            placeholder={
              committed.length === 0 && !input
                ? "tag: pid: message: 裸词 · 空格固化 · 点 ∧/∨ 调整分组"
                : ""
            }
            className={`w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/40 ${
              regexErr ? "text-destructive" : ""
            }`}
          />
        </span>
        {regexErr && (
          <span className="absolute bottom-full right-3 mb-1 rounded bg-destructive px-1.5 py-0.5 text-[10px] text-white">
            {regexErr}
          </span>
        )}
      </div>

      {/* 日志区：静态 mock，迷你求值器即时过滤 */}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {matched.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">0 命中</div>
        ) : (
          matched.map((e, i) => (
            <div key={i} className={`flex gap-2 whitespace-pre-wrap break-all ${levelColor(e.level)}`}>
              <span className="shrink-0 text-muted-foreground">{e.time}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground/50">{e.pid}</span>
              <span className="w-4 shrink-0 text-center font-bold">{e.level}</span>
              <span className="w-36 shrink-0 truncate text-left text-foreground/80">{e.tag}</span>
              <span className="min-w-0 flex-1">{e.message}</span>
            </div>
          ))
        )}
      </div>

      {/* FILTER JSON：preset 落盘 payload 实时预览 */}
      <div className="flex shrink-0 items-baseline gap-2 border-t bg-muted/20 px-3 py-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          FILTER
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70">
          {json}
        </span>
      </div>
    </div>
  );
}
