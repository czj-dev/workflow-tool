// PROTOTYPE（一次性）：原型会话标记 + 「URL 是否点名原型」的判定。
// 正式代码（main.tsx / slot.tsx）只静态依赖本文件：它不 import 任何原型模块、不含任何原型文案
//（VARIANTS 名称 / 说明都在 url-state 的 lazy chunk 一侧），且调用点全在 DEV 死分支里。
// installStub() 装好内存桩后置位；之后即使 URL 的 variant 被清空（切回「现行版」对照），
// 切换条与插槽仍按原型会话工作。
let session = false;

export function markProtoSession() {
  session = true;
}

export function isProtoSession(): boolean {
  return session;
}

export type VariantKey = "A" | "B" | "C";

export const isVariant = (v: string | null): v is VariantKey =>
  v === "A" || v === "B" || v === "C";

/** URL 是否点名了原型变体（?variant=A|B|C，忽略大小写）。与 url-state 的 readProtoState 同一判定，
 * 保证 main.tsx 不会「装了桩却没有变体」。 */
export function isProtoRequested(): boolean {
  const raw = new URLSearchParams(window.location.search).get("variant");
  return isVariant(raw?.toUpperCase() ?? null);
}
