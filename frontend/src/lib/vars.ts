// 变量回路工具：fragments 的 ${VAR} 引用 ↔ globalConfig 的变量定义。
// 与 internal/runner.Expand 行为保持一致——未命中的 ${VAR} 原样保留。
const VAR_RE = /\$\{([A-Za-z0-9_]+)\}/g;

/** 提取 content 中出现的所有变量名（去重、保序）。 */
export function extractVars(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(content)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** 按 vars 替换 ${VAR}，未命中保留 ${VAR} 原样。 */
export function expandVars(
  content: string,
  vars: Record<string, string>,
): string {
  return content.replace(VAR_RE, (m, k: string) => vars[k] ?? m);
}
