import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ReloadIcon, FastForwardIcon, Sun03Icon, Moon02Icon } from "@hugeicons/core-free-icons"
import { useTranslation } from "react-i18next"
import { LlmOutputPanel } from "./LlmOutputPanel"
import { MOCK_PROMPT, MOCK_STREAM_EVENTS } from "./mockStreamEvents"
import { applyEvent, EMPTY_PANEL_STATE, parseStreamLine } from "./reduceStream"

/**
 * LLM 输出面板 mockup 壳（dev 专用，经 ?mockup=llm 进入，不进主 bundle）。
 * 按真实抓取的事件时间轴回放：流式态（shimmer / 轨道流光 / 计数跳动）与终态一页可验。
 * 顶部工具条：重放 / 跳到终态 / 深浅主题切换。
 */
export function LlmOutputMockup() {
  useTranslation() // 面板文案走 i18n；壳自身文案写死中文（临时页面）
  const [state, setState] = useState(EMPTY_PANEL_STATE)
  const [playing, setPlaying] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const [dark, setDark] = useState(true) // app 深色为主力，默认深色验
  const idxRef = useRef(0)
  const startRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])

  // 回放主循环：rAF 按 wall-clock 找已到期事件依次应用（StrictMode 双挂载安全：cleanup 取消）
  useEffect(() => {
    if (!playing) return
    startRef.current = performance.now() - elapsed
    let raf = 0
    const tick = () => {
      const el = performance.now() - startRef.current
      setElapsed(el)
      while (idxRef.current < MOCK_STREAM_EVENTS.length && MOCK_STREAM_EVENTS[idxRef.current].atMs <= el) {
        const ev = MOCK_STREAM_EVENTS[idxRef.current]
        const parsed = parseStreamLine(ev.line)
        if (parsed) setState((s) => applyEvent(s, parsed, ev.atMs))
        idxRef.current++
      }
      if (idxRef.current >= MOCK_STREAM_EVENTS.length) {
        setPlaying(false)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  // 跟随滚动：state 增长时贴底（用户手动上滚后停止跟随——简单起见：始终贴底，mockup 够用）
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state])

  const replay = () => {
    idxRef.current = 0
    setState(EMPTY_PANEL_STATE)
    setElapsed(0)
    setPlaying(true)
  }

  const skipToEnd = () => {
    setPlaying(false)
    idxRef.current = MOCK_STREAM_EVENTS.length
    let s = EMPTY_PANEL_STATE
    for (const ev of MOCK_STREAM_EVENTS) {
      const parsed = parseStreamLine(ev.line)
      if (parsed) s = applyEvent(s, parsed, ev.atMs)
    }
    setState(s)
    setElapsed(MOCK_STREAM_EVENTS[MOCK_STREAM_EVENTS.length - 1]?.atMs ?? 0)
  }

  const total = MOCK_STREAM_EVENTS[MOCK_STREAM_EVENTS.length - 1]?.atMs ?? 0

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          LLM 输出面板 · Mockup
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
          {(elapsed / 1000).toFixed(1)}s / {(total / 1000).toFixed(1)}s
        </span>
        <div className="ms-auto flex items-center gap-2">
          <button
            type="button"
            onClick={replay}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
          >
            <HugeiconsIcon icon={ReloadIcon} strokeWidth={1.75} className="size-3.5" />
            重放
          </button>
          <button
            type="button"
            onClick={skipToEnd}
            disabled={!playing && elapsed >= total}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40"
          >
            <HugeiconsIcon icon={FastForwardIcon} strokeWidth={1.75} className="size-3.5" />
            跳到终态
          </button>
          <button
            type="button"
            onClick={() => setDark((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
          >
            <HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} strokeWidth={1.75} className="size-3.5" />
            {dark ? "浅色" : "深色"}
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <LlmOutputPanel prompt={MOCK_PROMPT} sentAtLabel="14:32:07" state={state} />
        </div>
      </div>

      {/* composer 影子：静态占位，只为呈现面板在真实页面中的上下文比例 */}
      <div className="border-t bg-muted/20 px-6 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-xl border border-input bg-background px-3 py-3 text-sm text-muted-foreground">
            输入发给 AI 的内容…
          </div>
        </div>
      </div>
    </div>
  )
}
