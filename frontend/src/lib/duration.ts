// Go time.Duration.String() 解析（后端 done/lastRun 事件携带的时长串，如 "495.555291ms"、
// "1m2s"、"2h45m"）：返回毫秒数；非整串消费（含空串/外来格式）返回 null。
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6, us: 1e-3, "\u00b5s": 1e-3, ms: 1, s: 1e3, m: 6e4, h: 36e5,
};
const GO_DURATION_PART = /(\d+(?:\.\d*)?|\.\d+)(ns|\u00b5s|us|ms|s|m|h)/g;

export function parseGoDurationMs(raw: string): number | null {
  let text = raw.trim();
  if (text.startsWith("-") || text.startsWith("+")) text = text.slice(1);
  if (!text) return null;
  let total = 0;
  let index = 0;
  for (const match of text.matchAll(GO_DURATION_PART)) {
    if (match.index !== index) return null;
    total += Number(match[1]) * GO_DURATION_UNIT_MS[match[2]];
    index = match.index + match[0].length;
  }
  if (index !== text.length) return null;
  return raw.trim().startsWith("-") ? -total : total;
}

// 后端时长串 → 项目统一读数格式；解析失败时原样返回（不吞非 Go 格式的外来串）。
export function fmtGoDuration(raw: string): string {
  const ms = parseGoDurationMs(raw);
  return ms === null ? raw : fmtDuration(ms);
}

// 耗时读数格式化：管线仪表带与步骤耗时列共用。
// <1min 保留一位小数（亚秒对调试有意义），≥1min 走 1m02s（不再带小数）。
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 60_000) {
    const s = ms / 1000;
    // 整秒不带小数尾巴（12s 而非 12.0s），非整秒一位小数（0.4s / 12.4s）
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}
