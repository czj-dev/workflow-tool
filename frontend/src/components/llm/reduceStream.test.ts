import { describe, expect, it } from "vitest"
import { applyEvent, EMPTY_PANEL_STATE, parseStreamLine } from "./reduceStream"
import { MOCK_STREAM_EVENTS } from "./mockStreamEvents"

// 用真实抓取的事件序列全流程跑归约器——这个序列同时是未来 Provider 接入的目标形态契约。
describe("reduceStream（真实 stream-json 序列）", () => {
  const final = MOCK_STREAM_EVENTS.reduce((s, ev) => {
    const parsed = parseStreamLine(ev.line)
    return parsed ? applyEvent(s, parsed, ev.atMs) : s
  }, EMPTY_PANEL_STATE)

  it("段序列 = 工序序列：思考 → 工具 → 思考 → 回答", () => {
    expect(final.segments.map((s) => s.kind)).toEqual(["thinking", "tool", "thinking", "answer"])
  })

  it("两段思考各自独立（工具结果回来后的新思考不续接旧段）", () => {
    const [t1, , t2] = final.segments
    expect(t1.kind).toBe("thinking")
    expect(t2.kind).toBe("thinking")
    expect((t1 as { text: string }).text).not.toContain("用户要两行信息")
    expect((t2 as { text: string }).text).toContain("用户要两行信息")
  })

  it("工具段按 id 回填结果与耗时", () => {
    const tool = final.segments[1]
    expect(tool.kind).toBe("tool")
    if (tool.kind !== "tool") return
    expect(tool.name).toBe("Read")
    expect(tool.summary).toBe("package.json")
    expect(tool.result).toContain("react")
    expect(tool.isError).toBeFalsy()
    expect(tool.durationMs).toBe(3900 - 2600)
  })

  it("回答文本为各增量块拼接", () => {
    const answer = final.segments[3]
    expect(answer.kind).toBe("answer")
    expect((answer as { text: string }).text.replace(/\n/g, "")).toContain("React 版本")
    expect((answer as { text: string }).text).toContain("Vite `^8`")
  })

  it("result 写入终点读数并结束流式", () => {
    expect(final.streaming).toBe(false)
    expect(final.readout).toEqual({
      durationMs: 18878,
      inputTokens: 21292,
      outputTokens: 193,
      costUsd: 0.129653,
      isError: false,
    })
  })

  it("每段耗时均已结算（终态无 null）", () => {
    for (const s of final.segments) expect(s.durationMs).not.toBeNull()
  })
})
