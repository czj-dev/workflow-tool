// frontend/src/lib/ai.test.ts
import { describe, expect, it } from "vitest";
import type { AiTaskItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import type { WorkflowStepState } from "../types/events";
import {
  aiCanRun,
  aiDraftFor,
  aiRunParams,
  flushAiReply,
  initialAiDraft,
  mergeAiReply,
  missingAiInputs,
} from "./ai";

const spec = (id: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({
  id,
  label: id,
  type: "text",
  required: false,
  default: "",
  options: [],
  description: undefined,
  ...extra,
});

// AI 任务夹具：只需 lib/ai.ts 用到的三个字段（params / prompt / system）
const task = (
  params: ParamSpec[],
  def: { prompt?: string; system?: string } = {},
) => ({ params, prompt: "解释 ${TOPIC}", system: "你是助手", ...def });

// 绑定把 prompt/system 标成必有 string；这里测的正是运行时字段缺失时的兜底，故绕过类型
const sparse = (raw: Record<string, unknown>): Pick<AiTaskItem, "params" | "prompt" | "system"> =>
  raw as unknown as Pick<AiTaskItem, "params" | "prompt" | "system">;

const step = (extra: Partial<WorkflowStepState> = {}): WorkflowStepState => ({
  index: 0,
  status: "running",
  lines: [],
  ...extra,
});
const text = (s: string) => ({ kind: "text" as const, text: s });

describe("initialAiDraft", () => {
  it("prompt/system 取定义模板原文，resume 从空开始", () => {
    expect(initialAiDraft(task([]), {})).toEqual({
      prompt: "解释 ${TOPIC}",
      system: "你是助手",
      resume: "",
    });
  });

  it("已声明参数：定义默认值 > 全局配置同名 key > 空串；默认值原样保留（模板由后端展开）", () => {
    const t = task([
      spec("TOPIC", { required: true, default: "季度报告" }),
      spec("DEPTH"),
      spec("LANG", { default: "${HOME}" }),
    ]);
    const draft = initialAiDraft(t, { TOPIC: "全局主题", DEPTH: "深" });
    expect(draft.TOPIC).toBe("季度报告"); // 默认值优先于全局配置
    expect(draft.DEPTH).toBe("深"); // 没默认值 → 取全局配置
    expect(draft.LANG).toBe("${HOME}"); // 模板默认值不在前端展开
    expect(initialAiDraft(task([spec("X")]), {}).X).toBe("");
  });

  it("定义缺 prompt/system 时按空串处理", () => {
    expect(initialAiDraft(sparse({ params: [], prompt: undefined, system: undefined }), {})).toEqual({
      prompt: "",
      system: "",
      resume: "",
    });
  });

  it("params 缺失时只有保留运行参数", () => {
    expect(initialAiDraft(sparse({ params: undefined, prompt: "p", system: "" }), {})).toEqual({
      prompt: "p",
      system: "",
      resume: "",
    });
  });
});

describe("aiDraftFor", () => {
  it("overlay 只覆写给出的键，其余键取初值", () => {
    const t = task([spec("TOPIC", { default: "季度报告" })]);
    expect(aiDraftFor(t, { TOPIC: "年报", prompt: "自定义提示词" }, {})).toEqual({
      prompt: "自定义提示词",
      system: "你是助手",
      resume: "",
      TOPIC: "年报",
    });
    expect(aiDraftFor(t, undefined, {})).toEqual(initialAiDraft(t, {}));
  });

  it("没改过的键跟随定义 / 全局配置的变化（改了默认值或配置后不必重置草稿）", () => {
    const t = task([spec("TOPIC", { default: "季度报告" }), spec("DEPTH")]);
    const overlay = { prompt: "自定义提示词" };
    expect(aiDraftFor(t, overlay, {}).TOPIC).toBe("季度报告");
    expect(aiDraftFor({ ...t, params: [spec("TOPIC", { default: "新月报" }), spec("DEPTH")] }, overlay, {}).TOPIC).toBe("新月报");
    expect(aiDraftFor(t, overlay, { DEPTH: "新配置" }).DEPTH).toBe("新配置");
  });

  it("overlay 里值为 undefined 的键视为撤回修改", () => {
    const draft = aiDraftFor(task([spec("TOPIC", { default: "季度报告" })]), { TOPIC: undefined }, {});
    expect(draft.TOPIC).toBe("季度报告");
  });
});

describe("missingAiInputs / aiCanRun", () => {
  const t = task([
    spec("TOPIC", { required: true, default: "季度报告" }),
    spec("TAGS", { type: "list", required: true }),
    spec("NOTE"),
  ]);
  const base = () => initialAiDraft(t, {});

  it("提示词为空（或全是空白）算未就绪，排在必填参数之前", () => {
    expect(missingAiInputs(t, { ...base(), prompt: "" })).toEqual(["prompt", "TAGS"]);
    expect(missingAiInputs(t, { ...base(), prompt: " \n " })).toEqual(["prompt", "TAGS"]);
  });

  it("必填参数未填 / list 为空数组算未就绪；非必填参数不影响", () => {
    expect(missingAiInputs(t, { ...base(), prompt: "p", TAGS: '["a"]', NOTE: "" })).toEqual([]);
    expect(missingAiInputs(t, { ...base(), prompt: "p", TAGS: "[]" })).toEqual(["TAGS"]);
    expect(missingAiInputs(t, { ...base(), prompt: "p", TOPIC: "" })).toEqual(["TOPIC", "TAGS"]);
  });

  it("aiCanRun 同时看必填与数组格式：list 不是合法 JSON 字符串数组时不可运行", () => {
    expect(aiCanRun(t, { ...base(), prompt: "p", TAGS: '["a"]' })).toBe(true);
    expect(aiCanRun(t, { ...base(), prompt: "p", TAGS: "not json" })).toBe(false);
    expect(aiCanRun(t, { ...base(), prompt: "p", TAGS: "[1]" })).toBe(false);
    expect(aiCanRun(t, { ...base(), prompt: "", TAGS: '["a"]' })).toBe(false);
  });
});

describe("aiRunParams", () => {
  const t = task([spec("TOPIC", { default: "季度报告" }), spec("DEPTH")]);

  it("prompt/system 恒传；没改过的已声明参数不传", () => {
    const draft = initialAiDraft(t, {});
    expect(aiRunParams(t, undefined, draft)).toEqual({ prompt: "解释 ${TOPIC}", system: "你是助手" });
    expect(aiRunParams(t, {}, draft)).toEqual({ prompt: "解释 ${TOPIC}", system: "你是助手" });
  });

  it("改过的已声明参数才发送（即便值等于默认值）", () => {
    const overlay = { TOPIC: "年报", DEPTH: "季度报告" };
    expect(aiRunParams(t, overlay, aiDraftFor(t, overlay, {}))).toEqual({
      prompt: "解释 ${TOPIC}",
      system: "你是助手",
      TOPIC: "年报",
      DEPTH: "季度报告",
    });
  });

  it("resume 去首尾空白后非空才发送", () => {
    const spaced = { resume: " sess-1 " };
    expect(aiRunParams(t, spaced, aiDraftFor(t, spaced, {})).resume).toBe("sess-1");
    const blank = { resume: "  " };
    expect(aiRunParams(t, blank, aiDraftFor(t, blank, {}))).not.toHaveProperty("resume");
  });

  it("未声明的键不会出现在发送参数里（后端对未声明参数报错）", () => {
    const overlay = { GHOST: "x", TOPIC: "y" };
    expect(aiRunParams(t, overlay, aiDraftFor(t, overlay, {}))).not.toHaveProperty("GHOST");
  });
});

describe("mergeAiReply", () => {
  it("增量先攒在 aiPartial，凑满一行才落 text 行", () => {
    let s = step();
    s = mergeAiReply(s, "Hel");
    expect(s.aiPartial).toBe("Hel");
    s = mergeAiReply(s, "lo");
    expect(s.aiPartial).toBe("Hello");
    expect(s.lines).toEqual([]);
    s = mergeAiReply(s, " w\n");
    expect(s.lines).toEqual([text("Hello w")]);
    expect(s.aiPartial).toBe("");
    // 普通文本行之后 lastWasProgress 复位（下一条 progress 不会覆盖它）
    expect(s.lastWasProgress).toBe(false);
  });

  it("一个增量里的多行逐行落桶；空行不落桶", () => {
    expect(mergeAiReply(step(), "a\n\nb\n").lines).toEqual([text("a"), text("b")]);
    expect(mergeAiReply(step(), "a\n\nb\n").aiPartial).toBe("");
  });

  it("CRLF：行尾的 \\r 不进文本；\\r 与 \\n 分两次到达也拼成换行", () => {
    let s = mergeAiReply(step(), "a\r\n");
    expect(s.lines).toEqual([text("a")]);
    s = mergeAiReply(s, "b\r");
    expect(s.aiPartial).toBe("b");
    s = mergeAiReply(s, "\nc");
    expect(s.lines).toEqual([text("a"), text("b")]);
    expect(s.aiPartial).toBe("c");
  });

  it("空增量原样返回（同一个对象）", () => {
    const s = step({ aiPartial: "x" });
    expect(mergeAiReply(s, "")).toBe(s);
  });

  it("不修改传入的步骤对象", () => {
    const s = step({ aiPartial: "x" });
    const next = mergeAiReply(s, "y\nz");
    expect(s.lines).toEqual([]);
    expect(s.aiPartial).toBe("x");
    expect(next.lines).toEqual([text("xy")]);
    expect(next.aiPartial).toBe("z");
  });

  it("步骤已收尾（done / error）才到的增量：先把半行尾巴落行，再把这段整体当作后续行", () => {
    let s = step({ status: "done", lines: [text("前")], aiPartial: "半行" });
    s = mergeAiReply(s, "迟到\n尾巴");
    expect(s.lines).toEqual([text("前"), text("半行"), text("迟到"), text("尾巴")]);
    expect(s.aiPartial).toBeUndefined();
    const e = mergeAiReply(step({ status: "error" }), "迟到的最后一段");
    expect(e.lines).toEqual([text("迟到的最后一段")]);
    expect(e.aiPartial).toBeUndefined();
  });
});

describe("flushAiReply", () => {
  it("把未凑满行的尾巴落成最后一行并摘掉 aiPartial", () => {
    const s = flushAiReply(step({ lines: [text("a")], aiPartial: "尾\r" }));
    expect(s.lines).toEqual([text("a"), text("尾")]);
    expect("aiPartial" in s).toBe(false);
  });

  it("没有尾巴时行不变，也不引入空行", () => {
    expect(flushAiReply(step({ lines: [text("a")], aiPartial: "" })).lines).toEqual([text("a")]);
    expect(flushAiReply(step({ lines: [text("a")] })).lines).toEqual([text("a")]);
  });

  it("落下的尾巴是普通文本行（lastWasProgress 复位）", () => {
    expect(flushAiReply(step({ aiPartial: "尾", lastWasProgress: true })).lastWasProgress).toBe(false);
  });
});
