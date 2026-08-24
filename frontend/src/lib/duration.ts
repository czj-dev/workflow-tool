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
