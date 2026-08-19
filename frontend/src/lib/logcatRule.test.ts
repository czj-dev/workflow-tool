import { describe, expect, it } from "vitest";
import type { LogcatRule } from "../types/events";
import {
  parseToken,
  parseInput,
  invalidRegex,
  tokenText,
  ruleFromParams,
  ruleToParams,
  sortHistogram,
} from "./logcatRule";

describe("parseToken", () => {
  it("裸词 → any contains", () => {
    expect(parseToken("crash")).toEqual({
      key: "any",
      op: "contains",
      negated: false,
      value: "crash",
    });
  });

  it("tag:Foo → tag contains；- 前缀取反", () => {
    expect(parseToken("tag:Foo")).toEqual({
      key: "tag",
      op: "contains",
      negated: false,
      value: "Foo",
    });
    expect(parseToken("-tag:Foo")).toEqual({
      key: "tag",
      op: "contains",
      negated: true,
      value: "Foo",
    });
  });

  it("tag=:Foo 精确；tag~:Foo 正则；msg 别名映射 message", () => {
    expect(parseToken("tag=:Foo").op).toBe("exact");
    expect(parseToken("tag~:Foo").op).toBe("regex");
    expect(parseToken("msg:boom").key).toBe("message");
  });

  it("pid/tid 仅精确（op 归一 exact）", () => {
    expect(parseToken("pid:123")).toEqual({
      key: "pid",
      op: "exact",
      negated: false,
      value: "123",
    });
    expect(parseToken("tid:45").op).toBe("exact");
  });

  it("引号包裹的值去引号（保留内部空格）", () => {
    expect(parseToken('message:"foo bar"').value).toBe("foo bar");
  });

  it("未知 key 按裸词（any）容错；空串归一 any", () => {
    expect(parseToken("what:x").key).toBe("any");
    expect(parseToken("what:x").value).toBe("what:x");
    expect(parseToken("  ")).toEqual({
      key: "any",
      op: "contains",
      negated: false,
      value: "",
    });
  });
});

describe("parseInput", () => {
  it("空格分段，末段草稿；引号段内空格不拆", () => {
    const toks = parseInput('tag:Foo message:"a b" raw');
    expect(toks.map((t) => t.key)).toEqual(["tag", "message", "any"]);
    expect(toks.map((t) => t.value)).toEqual(["Foo", "a b", "raw"]);
    expect(toks.map((t) => t.draft)).toEqual([false, false, true]);
  });

  it("tokenText 往返（chip 可复制形态）", () => {
    const toks = parseInput("-tag:Foo tag=:Bar tag~:Baz pid:1 crash");
    expect(toks.map(tokenText)).toEqual([
      "-tag:Foo",
      "tag=:Bar",
      "tag~:Baz",
      "pid=:1",
      "crash",
    ]);
  });
});

describe("invalidRegex", () => {
  it("非法正则检出，合法通过", () => {
    expect(invalidRegex("[abc")).toBe(true);
    expect(invalidRegex("(a|b)")).toBe(false);
    expect(invalidRegex("")).toBe(false);
  });
});

describe("ruleFromParams", () => {
  it("LEVEL/TAG/INCLUDE/EXCLUDE/PACKAGE 全量映射", () => {
    expect(
      ruleFromParams({
        LEVEL: "w",
        TAG: "Foo Bar",
        INCLUDE: "anr",
        EXCLUDE: "chatty",
        PACKAGE: "com.example",
      }),
    ).toEqual({
      minLevel: "W",
      package: "com.example",
      tokens: [
        { key: "tag", op: "contains", negated: false, value: "Foo" },
        { key: "tag", op: "contains", negated: false, value: "Bar" },
        { key: "message", op: "contains", negated: false, value: "anr" },
        { key: "message", op: "contains", negated: true, value: "chatty" },
      ],
    });
  });

  it("缺省/非法 LEVEL 归一 V；空参数得空规则且不共享 EMPTY 引用", () => {
    const empty = ruleFromParams(undefined);
    expect(empty).toEqual({ tokens: [], minLevel: "V", package: "" });
    expect(empty.tokens).not.toBe([]); // 逐字段新建，规避共享引用
    expect(ruleFromParams({ LEVEL: "X" }).minLevel).toBe("V");
  });

  it("FILTER 优先：regex/pid/取反等完整规则整体还原，legacy 键被忽略", () => {
    const rule: LogcatRule = {
      tokens: [
        { key: "tag", op: "regex", negated: false, value: "^Foo" },
        { key: "pid", op: "exact", negated: false, value: "123" },
        { key: "message", op: "contains", negated: true, value: "chatty" },
        { key: "any", op: "contains", negated: false, value: "crash" },
      ],
      minLevel: "W",
      package: "com.example",
    };
    expect(ruleFromParams({ ...ruleToParams(rule), TAG: "LIES" })).toEqual(rule);
  });

  it("FILTER 中含 draft 标记的 token 被剥离", () => {
    const withDraft = {
      tokens: [
        { key: "tag", op: "contains", negated: false, value: "Foo", draft: false },
        { key: "tag", op: "contains", negated: false, value: "Bo", draft: true },
      ],
      minLevel: "V",
      package: "",
    };
    expect(ruleFromParams({ FILTER: JSON.stringify(withDraft) }).tokens).toEqual([
      { key: "tag", op: "contains", negated: false, value: "Foo" },
      { key: "tag", op: "contains", negated: false, value: "Bo" },
    ]); // draft 未携带：字段白名单拷贝
  });

  it("非法 JSON 的 FILTER 退化 legacy 映射（手改 yaml 写坏不炸）", () => {
    expect(
      ruleFromParams({ FILTER: "{oops", LEVEL: "E", TAG: "Foo" }).tokens,
    ).toEqual([{ key: "tag", op: "contains", negated: false, value: "Foo" }]);
  });
});

describe("ruleToParams", () => {
  it("空规则不写 FILTER，LEVEL 归一 V", () => {
    expect(ruleToParams({ tokens: [], minLevel: "V", package: "" })).toEqual({
      LEVEL: "V",
    });
  });

  it("可无损表达的规则同步写 legacy 键", () => {
    const values = ruleToParams({
      tokens: [
        { key: "tag", op: "contains", negated: false, value: "Foo" },
        { key: "tag", op: "contains", negated: false, value: "Bar" },
        { key: "message", op: "contains", negated: false, value: "anr" },
        { key: "message", op: "contains", negated: true, value: "chatty" },
      ],
      minLevel: "W",
      package: "com.example",
    });
    expect(values.LEVEL).toBe("W");
    expect(values.PACKAGE).toBe("com.example");
    expect(values.TAG).toBe("Foo Bar");
    expect(values.INCLUDE).toBe("anr");
    expect(values.EXCLUDE).toBe("chatty");
    expect(JSON.parse(values.FILTER!)).toEqual({
      tokens: [
        { key: "tag", op: "contains", negated: false, value: "Foo" },
        { key: "tag", op: "contains", negated: false, value: "Bar" },
        { key: "message", op: "contains", negated: false, value: "anr" },
        { key: "message", op: "contains", negated: true, value: "chatty" },
      ],
      minLevel: "W",
      package: "com.example",
    });
  });

  it("regex/pid/取反不可表达时省略对应 legacy 键，但 FILTER 全量携带", () => {
    const values = ruleToParams({
      tokens: [
        { key: "tag", op: "regex", negated: false, value: "^Foo" },
        { key: "pid", op: "exact", negated: false, value: "123" },
        { key: "message", op: "contains", negated: false, value: "a" },
        { key: "message", op: "contains", negated: false, value: "b" },
      ],
      minLevel: "V",
      package: "",
    });
    expect(values.TAG).toBeUndefined();
    expect(values.INCLUDE).toBeUndefined(); // 多个正向 message contains 无法单槽表达
    expect(values.EXCLUDE).toBeUndefined();
    expect(Object.keys(JSON.parse(values.FILTER!)).sort()).toEqual([
      "minLevel",
      "package",
      "tokens",
    ]);
  });

  it("往返：任意规则 → params → rule 等价（含 draft 剥离）", () => {
    const rule: LogcatRule = {
      tokens: [
        { key: "tag", op: "regex", negated: true, value: "^Foo[0-9]+" },
        { key: "pid", op: "exact", negated: false, value: "42" },
        { key: "tid", op: "exact", negated: true, value: "7" },
        { key: "message", op: "exact", negated: false, value: "foo bar" },
        { key: "any", op: "contains", negated: false, value: "crash" },
        { key: "tag", op: "contains", negated: false, value: "Has Space" },
      ],
      minLevel: "E",
      package: "com.example",
    };
    expect(ruleFromParams(ruleToParams(rule))).toEqual(rule);
  });

  it("link 往返：or 保留、and/缺省省略（FILTER JSON 减噪音）", () => {
    const rule: LogcatRule = {
      tokens: [
        { key: "tag", op: "contains", negated: false, value: "SystemUI" },
        { key: "message", op: "contains", negated: false, value: "nav" },
        { key: "tag", op: "contains", negated: false, value: "AudioFlinger", link: "or" },
        { key: "message", op: "contains", negated: false, value: "track", link: "and" },
      ],
      minLevel: "V",
      package: "",
    };
    const values = ruleToParams(rule);
    const parsed = JSON.parse(values.FILTER!);
    expect(parsed.tokens[2]).toEqual({
      key: "tag",
      op: "contains",
      negated: false,
      value: "AudioFlinger",
      link: "or",
    });
    expect(parsed.tokens[3].link).toBeUndefined(); // and 显式写同缺省，省略
    expect(ruleFromParams(values)).toEqual({
      tokens: [
        { key: "tag", op: "contains", negated: false, value: "SystemUI" },
        { key: "message", op: "contains", negated: false, value: "nav" },
        { key: "tag", op: "contains", negated: false, value: "AudioFlinger", link: "or" },
        { key: "message", op: "contains", negated: false, value: "track" },
      ],
      minLevel: "V",
      package: "",
    }); // and 归一为缺省、draft 剥离后等价
  });
});

describe("sortHistogram", () => {
  it("频次降序，并列按 tag 字典序", () => {
    expect(
      sortHistogram({ b: 2, a: 2, c: 5, d: 1 }),
    ).toEqual([
      ["c", 5],
      ["a", 2],
      ["b", 2],
      ["d", 1],
    ]);
  });
});
