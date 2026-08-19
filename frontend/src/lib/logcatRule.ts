// logcat 统一规则的纯前端逻辑：输入语法解析、params→规则映射、直方图排序。
// 语义与 spec 定稿（docs/superpowers/specs/2026-08-18-logcat-filter-chips-design.md）
// 及 mockup 引擎 mockLogcat.ts 对照移植；求值在后端（Go 唯一求值器），此处只做编辑侧。
import type { LogcatKey, LogcatOp, LogcatRule, LogcatToken } from "../types/events";

// key 别名：msg→message；其余 key 原样（spec：`message` 别名 `msg`，两者都接受）。
// 未知 key 按裸词（any）处理（输入容错）。
const KEY_ALIASES: Record<string, LogcatKey> = {
  msg: "message",
  message: "message",
  tag: "tag",
  pid: "pid",
  tid: "tid",
};

// 解析单个 token 文本：`[-]key[=|~]:value`，裸词 → any。
// 值支持一对引号包裹（`message:"foo bar"`）；pid/tid 仅精确（op 归一 exact）。
export function parseToken(text: string): LogcatToken {
  const t = text.trim();
  if (!t) return { key: "any", op: "contains", negated: false, value: "" };
  let negated = false;
  let s = t;
  if (s.startsWith("-") && s.length > 1) {
    negated = true;
    s = s.slice(1);
  }
  let key: LogcatKey = "any";
  let op: LogcatOp = "contains";
  let value = s;
  const ci = s.indexOf(":");
  if (ci > 0) {
    const head = s.slice(0, ci); // 形如 tag / tag= / tag~
    const vm = head.match(/^([a-zA-Z]+)([=~])?$/);
    if (vm) {
      const k = KEY_ALIASES[vm[1].toLowerCase()] ?? null;
      if (k) {
        key = k;
        op = vm[2] === "=" ? "exact" : vm[2] === "~" ? "regex" : "contains";
        value = s.slice(ci + 1);
      }
    }
  }
  value = value.replace(/^"(.*)"$/, "$1");
  if (key === "pid" || key === "tid") op = "exact"; // 数字维度仅精确
  return { key, op, negated, value };
}

// 把输入框文本拆成 tokens：已敲空格的段为正式，末段为草稿（即时参与过滤的未定稿态）。
// 引号段内空格不拆分。
export function parseInput(text: string): LogcatToken[] {
  const segs: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === " " && !inQuote) {
      if (cur.trim()) segs.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segs.push(cur.trim());
  return segs.map((s, i) => {
    const token = parseToken(s);
    token.draft = i === segs.length - 1;
    return token;
  });
}

// 非法正则检测（固化/转正则时前端先拦一道；后端 CompileRule 是最终防线）。
export function invalidRegex(v: string): boolean {
  try {
    new RegExp(v);
    return false;
  } catch {
    return true;
  }
}

// token → 控制台文本（chip 的可复制形态；行内点击 toggle 的去重键）。
// 裸词（any+contains）不带 `:` 前缀，保证 parseToken(tokenText(t)) 往返一致。
export function tokenText(t: LogcatToken): string {
  const key = t.key === "any" ? "" : t.key;
  const bare = key === "" && t.op === "contains";
  const op = bare
    ? ""
    : t.op === "exact"
      ? "=:"
      : t.op === "regex"
        ? "~:"
        : ":";
  return `${t.negated ? "-" : ""}${key}${op}${t.value}`;
}

// FILTER 保留参数键：preset 携带完整规则的权威载体（甲板「存为预设」写入，
// 后端 ParamFilter 同名常量）。legacy 键表达不了 chip 语言，FILTER 在则整体采用。
const PARAM_FILTER = "FILTER";

// 启动参数 → 初始规则。优先解析 FILTER（JSON 可解析即整体采用，与后端
// RuleFromParamsExt 同构；draft 剥离——运行态规则无草稿）；否则走 legacy 映射：
// LEVEL→minLevel；TAG 按空白拆分为多个 tag contains token；INCLUDE/EXCLUDE→message
// 正/负 contains token；PACKAGE→package（只读 chip）。
export function ruleFromParams(
  params: Record<string, unknown> | undefined,
): LogcatRule {
  const filterRaw = String(params?.[PARAM_FILTER] ?? "").trim();
  if (filterRaw) {
    try {
      const r = JSON.parse(filterRaw) as LogcatRule;
      if (r && Array.isArray(r.tokens)) {
        return {
          tokens: r.tokens.map((tk) => ({
            key: tk.key,
            op: tk.op,
            negated: tk.negated,
            value: tk.value,
            ...(tk.link === "or" ? { link: "or" as const } : {}),
          })),
          minLevel: r.minLevel || "V",
          package: r.package ?? "",
        };
      }
    } catch {
      // 非法 JSON（手改 yaml 写坏）→ 退化 legacy 映射，与后端一致
    }
  }
  const lvlRaw = String(params?.LEVEL ?? "").trim().toUpperCase();
  // 不展开 EMPTY_LOGCAT_RULE（会共享其 tokens 数组引用），逐字段新建。
  const rule: LogcatRule = {
    tokens: [],
    minLevel: lvlRaw && "VDIWEF".includes(lvlRaw[0]) ? lvlRaw[0] : "V",
    package: String(params?.PACKAGE ?? ""),
  };
  for (const tag of String(params?.TAG ?? "").split(/\s+/)) {
    if (tag) rule.tokens.push({ key: "tag", op: "contains", negated: false, value: tag });
  }
  const include = String(params?.INCLUDE ?? "");
  if (include) {
    rule.tokens.push({ key: "message", op: "contains", negated: false, value: include });
  }
  const exclude = String(params?.EXCLUDE ?? "");
  if (exclude) {
    rule.tokens.push({ key: "message", op: "contains", negated: true, value: exclude });
  }
  return rule;
}

// 规则 → preset 参数值（甲板「存为预设」用）。FILTER 承载全量规则（权威，
// ruleFromParams 优先解析，往返无损）；legacy 键仅在可无损表达时写入——供表单
// 展示与手写 yaml 阅读，避免语义错位（TAG 按空白拆分，值含空白不可表达即省略；
// INCLUDE/EXCLUDE 单槽，恰一个 message contains 时写入）。
// 空规则（无 tokens/包名/非 V 阈值）不写 FILTER，减少 yaml 噪音。
export function ruleToParams(rule: LogcatRule): Record<string, string> {
  const tokens = rule.tokens.filter((tk) => tk.value);
  const values: Record<string, string> = { LEVEL: rule.minLevel || "V" };
  if (rule.package) values.PACKAGE = rule.package;
  const tagTok = tokens.filter((tk) => tk.key === "tag");
  const tagPlain = tagTok.filter(
    (tk) => tk.op === "contains" && !tk.negated && !/\s/.test(tk.value),
  );
  if (tagTok.length > 0 && tagTok.length === tagPlain.length)
    values.TAG = tagPlain.map((tk) => tk.value).join(" ");
  const inc = tokens.filter(
    (tk) => tk.key === "message" && tk.op === "contains" && !tk.negated,
  );
  if (inc.length === 1) values.INCLUDE = inc[0].value;
  const exc = tokens.filter(
    (tk) => tk.key === "message" && tk.op === "contains" && tk.negated,
  );
  if (exc.length === 1) values.EXCLUDE = exc[0].value;
  if (tokens.length || rule.package || (rule.minLevel && rule.minLevel !== "V")) {
    values.FILTER = JSON.stringify({
      tokens: tokens.map((tk) => ({
        key: tk.key,
        op: tk.op,
        negated: tk.negated,
        value: tk.value,
        ...(tk.link === "or" ? { link: "or" as const } : {}),
      })),
      minLevel: rule.minLevel || "V",
      package: rule.package ?? "",
    });
  }
  return values;
}

// 直方图排序：频次降序、并列按 tag 字典序（与后端 topTags 同规则，前端补全层/快捷条共用）。
export function sortHistogram(hist: Record<string, number>): Array<[string, number]> {
  return Object.entries(hist).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
}
