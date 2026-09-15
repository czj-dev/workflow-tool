// logcat 命中高亮的纯前端逻辑：后端 marks 四元组 → 文本切分与取色。
// 区间来源是后端唯一求值器（Go rule.go CompiledRule.Marks），此处只消费不匹配；
// 协议契约见 types/events.ts LogcatEntry.marks（四元组 [t,f,s,l]、UTF-16 单位、
// 按 (t,f,s) 升序）。求值/测试对照：internal/adb/logcat/rule_test.go Marks 用例。

// 色板大小：token 序位 % 8 取色（index.css --mark-1..8 / --mark-h-1..8）。
export const MARK_PALETTE_SIZE = 8;

// marks 域码（与 Go rule.go fieldMessage/fieldTag/fieldPid 常量对齐）。
export const MARK_FIELD_MESSAGE = 0;
export const MARK_FIELD_TAG = 1;
export const MARK_FIELD_PID = 2;

// token 序位 → 色号 1..8（循环）。负下标（防御性，不应出现）绕回色板。
export function markColorOf(tokenIdx: number): number {
  return (((tokenIdx % MARK_PALETTE_SIZE) + MARK_PALETTE_SIZE) % MARK_PALETTE_SIZE) + 1;
}

// 切分片段：命中段带色号（1..8），普通段 color=null。
export interface MarkPiece {
  text: string;
  color: number | null;
}

function plain(text: string): MarkPiece[] {
  return [{ text, color: null }];
}

// 按域过滤并把 marks 应用到文本：逐 code unit 记归属（后写覆盖 = 契约的
// 「按序后者覆盖」），再合并连续同色段。marks 缺省/空/该域无命中 → 单段原文。
// 越界与非法四元组钳制跳过（防御后端异常数据，渲染永不抛错）。
export function splitMarked(
  text: string,
  marks: number[][] | undefined,
  field: number,
): MarkPiece[] {
  const n = text.length;
  if (!marks || marks.length === 0 || n === 0) return plain(text);
  // owner[i]：第 i 个 code unit 归属的 token 下标（-1 = 无标注）
  const owner = new Int32Array(n).fill(-1);
  let any = false;
  for (const m of marks) {
    if (!Array.isArray(m) || m.length !== 4 || m[1] !== field) continue;
    const start = Math.max(0, Math.floor(m[2]));
    const end = Math.min(n, Math.floor(m[2]) + Math.floor(m[3]));
    for (let i = start; i < end; i++) {
      owner[i] = m[0];
      any = true;
    }
  }
  if (!any) return plain(text);
  const pieces: MarkPiece[] = [];
  let from = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || owner[i] !== owner[from]) {
      pieces.push({
        text: text.slice(from, i),
        color: owner[from] < 0 ? null : markColorOf(owner[from]),
      });
      from = i;
    }
  }
  return pieces;
}

// 该域首个命中段的色号（pid 整格标记用：整列只有一个值，取首个即够）。
export function fieldMarkColor(marks: number[][] | undefined, field: number): number | null {
  for (const m of marks ?? []) {
    if (Array.isArray(m) && m.length === 4 && m[1] === field) return markColorOf(m[0]);
  }
  return null;
}
