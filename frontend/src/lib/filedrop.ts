// 窗口级文件拖拽的取值与落点规则（Wails EnableFileDrop → main.go 转发 file:dropped）。
// 两个消费方共用这里的规则：ActionRunnerProvider 写普通输入框，FragmentsList 写片段变量 pill。

/** file:dropped 的 payload：paths 为拖入的全部路径，x/y 为松手时的 CSS 像素坐标。 */
export type FileDropPayload = { paths?: string[]; x?: number; y?: number };

/** 只在输入框上标注即可让该字段只取首个路径（path/file 类型参数用，值语义是单个路径）。 */
export const DROP_SINGLE_ATTR = "data-drop-single";

/**
 * 多路径按拖入顺序空格拼接；含空格的路径加双引号，否则拼出的值在命令行里会被拆成多个参数。
 * 只处理空格——路径自带引号或 shell 特殊字符不做转义（这类文件名极罕见，见 docs/action.md）。
 * 注意顺序只与系统给的数组同序，不等于用户在文件管理器里看到的排列。
 */
export function joinDroppedPaths(paths: string[]): string {
  return paths.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ");
}

/**
 * 按松手坐标定位可写入的输入框。精确命中控件就用它；否则向上找 Field 容器再向下取控件——
 * path/file 字段是 ButtonGroup 包 Input + 按钮、搜索框是 InputGroup 包图标，鼠标很容易落在
 * 这些遮挡物或标签上，视觉上却明明是同一个字段。disabled/readonly 一律跳过：绕过组件自己的
 * 禁用语义写值，会被下一次渲染冲掉，表现为「填了一下又没了」，比什么都不发生更困惑。
 */
export function findDropInput(
  x: number,
  y: number,
): HTMLInputElement | HTMLTextAreaElement | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const el =
    hit instanceof HTMLInputElement || hit instanceof HTMLTextAreaElement
      ? hit
      : hit.closest('[data-slot="field"]')?.querySelector("input, textarea");
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    return null;
  }
  return el.disabled || el.readOnly ? null : el;
}

/** 目标字段按 DROP_SINGLE_ATTR 决定取首个还是拼接全部。 */
export function valueForInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  paths: string[],
): string {
  return el.hasAttribute(DROP_SINGLE_ATTR) ? paths[0] : joinDroppedPaths(paths);
}

/**
 * 写入 React 受控组件：直接赋 value 不会触发 onChange，必须走原生 setter + input 事件。
 * 写完聚焦，光标留在框里便于接着编辑。
 */
export function writeToInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}
