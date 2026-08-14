import { EditorView } from "@codemirror/view";

// 测试工具：直接经由已挂载的 CodeMirror EditorView 读写编辑器内容。
// CodeMirror 的可编辑面是 contenteditable 的 .cm-content（无 .value 属性），
// 且 jsdom 无法可靠模拟物理键盘输入到 CodeMirror；故用 view.dispatch 触发改动，
// 它与真实输入走同一条 onChange → setText 路径（验证组件接线而非 DOM 输入层）。
function view(): EditorView {
  const el = document.querySelector(".cm-editor") as HTMLElement | null;
  if (!el) throw new Error("CodeMirror .cm-editor 未在 DOM 中找到");
  const v = EditorView.findFromDOM(el);
  if (!v) throw new Error("EditorView 未挂载到 .cm-editor");
  return v;
}

/** 读取编辑器全文（与编辑器 state.doc 一致）。 */
export function getCmValue(): string {
  return view().state.doc.toString();
}

/** 模拟用户在文档末尾插入文本并移动光标到末尾（触发 onChange，置 dirty）。 */
export function typeIntoCm(insert: string): void {
  const v = view();
  const len = v.state.doc.length;
  v.dispatch({
    changes: { from: len, insert },
    selection: { anchor: len + insert.length },
  });
}
