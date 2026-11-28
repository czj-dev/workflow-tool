import { useCallback, useState, type FocusEvent } from "react";

// 分区焦点提亮（规格 E/F 两页共用样板）：容器挂上返回的捕获焦点处理器，
// 焦点落到哪个 [data-sec] 分区（含气泡 / 下拉里带 data-sec 的内容），哪个分区
// 整段提亮（data-lit）；失焦清空。返回的 lit 与分区键（data-sec 的值）比对后
// 写进 data-lit。
export function useLitSection() {
  const [lit, setLit] = useState<string | null>(null);
  const onFocusCapture = useCallback((e: FocusEvent<HTMLElement>) => {
    const sec = e.target instanceof Element ? e.target.closest("[data-sec]") : null;
    setLit(sec?.getAttribute("data-sec") ?? null);
  }, []);
  const onBlurCapture = useCallback(() => setLit(null), []);
  return { lit, onFocusCapture, onBlurCapture };
}
