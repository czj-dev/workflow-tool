// PROTOTYPE（一次性）：三套变体共用的小 UI 状态——分组折叠集合、焦点所在分区、关闭编辑器后的焦点归还。
// 放 .ts 而非各 Variant 文件：组件文件只导出组件（react-refresh/only-export-components），
// 且三套变体的折叠状态各持一份（互不影响，比较时切回来还在）。
import { useEffect, useRef, useState, type FocusEvent } from "react";

/** 折叠集合（默认全展开）。 */
export function useCollapsed() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const expand = (id: string) =>
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  return { collapsed, toggle, expand };
}

// 「关闭后把焦点还给这一行」的待办标记：按 ref 对象记在模块级。不让 hook 返回 { el, request }——
// React Compiler 的 refs 规则只要看见返回值里裹着 ref，就把渲染期间读它的任何属性都算作访问 ref。
const returnFocusPending = new WeakSet<object>();

/** 挂在「就地编辑器收起后的那一行」上的 ref。行重新挂载后的那次 effect 里，若有人预约过，就把焦点放回去。 */
export function useReturnFocus<T extends HTMLElement = HTMLDivElement>() {
  const el = useRef<T | null>(null);
  useEffect(() => {
    if (returnFocusPending.delete(el) && el.current) el.current.focus();
  });
  return el;
}

/** 键盘收起就地编辑器前调用（事件处理器里）：收起后焦点回到那一行，而不是掉回 body。 */
export function requestReturnFocus(el: object): void {
  returnFocusPending.add(el);
}

/** 正在交互的分区（焦点所在的 [data-sec]）→ 变体 A 用它给整个分区加 data-lit 提亮。 */
export function useLit() {
  const [lit, setLit] = useState<string | null>(null);
  return {
    lit,
    onFocusCapture: (e: FocusEvent<HTMLElement>) => {
      const sec = e.target instanceof Element ? e.target.closest("[data-sec]") : null;
      setLit(sec?.getAttribute("data-sec") ?? null);
    },
    onBlurCapture: () => setLit(null),
  };
}
