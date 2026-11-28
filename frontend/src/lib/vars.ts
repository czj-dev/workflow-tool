// 变量回路工具：fragments 的 ${VAR} 引用 ↔ globalConfig 的变量定义。
// 与 internal/runner 的两段模型保持一致：config 值是模板（可互相引用，先经
// resolveGlobalConfig 解到终值），用户输入是数据（expandVars 单遍替换、不传递展开）。
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

/** 嵌套展开的最大链深：与 internal/runner 的 maxVarChain 保持一致。 */
const MAX_VAR_CHAIN = 8;

/**
 * 按 vars 单遍替换 ${VAR}，未命中保留 ${VAR} 原样；命中值里的 ${VAR} 不再继续
 * 展开——用户输入（片段复制时的临时填写、AI 任务输入）是数据不是模板。
 * config 值的嵌套引用先由 resolveGlobalConfig 解到终值再进 vars。
 */
export function expandVars(
  content: string,
  vars: Record<string, string>,
): string {
  return content.replace(VAR_RE, (m, k: string) => vars[k] ?? m);
}

/**
 * 把全局配置（config.yaml 快照）解析成终值：值之间可互相引用（如
 * USER: /Users/v → DOCS: ${USER}/Documents → OUTPUT_DIR: ${DOCS}/docs），
 * 按同一份 map 递归展开；链上重名（环引用）或超过 MAX_VAR_CHAIN 层时值保留
 * 原样。与 internal/runner.ResolveGlobal 行为保持一致（前端无内置变量/env 层，
 * 未命中的 ${VAR} 保留字面量）。
 */
export function resolveGlobalConfig(global: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(global)) {
    out[key] = resolveGlobalValue(global[key], global, []);
  }
  return out;
}

function resolveGlobalValue(
  content: string,
  global: Record<string, string>,
  chain: string[],
): string {
  return content.replace(VAR_RE, (m, k: string) => {
    const value = global[k];
    if (value === undefined) return m;
    if (!value.includes("${")) return value;
    if (chain.includes(k) || chain.length >= MAX_VAR_CHAIN) return value;
    return resolveGlobalValue(value, global, [...chain, k]);
  });
}
