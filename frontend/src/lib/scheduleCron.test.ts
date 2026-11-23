import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import {
  describeScheduleCron,
  formatScheduleCronField,
  formatScheduleNextRun,
  nextScheduleRuns,
  parseScheduleCron,
  serializeScheduleCron,
  updateScheduleCronField,
  type ScheduleTranslate,
} from "./scheduleCron";

// 句子/措辞断言直接走真实 zh 词典：既测组句规则，也能抓出 i18n 漏键。
const t = i18n.t.bind(i18n) as ScheduleTranslate;
const describeCron = (expression: string) => describeScheduleCron(parseScheduleCron(expression), t);

describe("schedule cron helpers", () => {
  it("parses all five fields including ranges and lists", () => {
    const parsed = parseScheduleCron("5,10-12 8-10 1,15 1,6 1-5");

    expect(parsed).toEqual({
      minute: { mode: "values", values: [5, 10, 11, 12] },
      hour: { mode: "values", values: [8, 9, 10] },
      day: { mode: "values", values: [1, 15] },
      month: { mode: "values", values: [1, 6] },
      weekday: { mode: "values", values: [1, 2, 3, 4, 5] },
    });
  });

  it("keeps wildcard distinct from selecting every value", () => {
    const parsed = parseScheduleCron("* * * * *");

    expect(serializeScheduleCron(parsed)).toBe("* * * * *");
    expect(
      serializeScheduleCron({
        ...parsed,
        minute: { mode: "values", values: Array.from({ length: 60 }, (_, index) => index) },
      }),
    ).toBe("0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59 * * * *");
  });

  it("updates one field immutably and serializes it as a value list", () => {
    const original = parseScheduleCron("0 8 * * 1-5");
    const updated = updateScheduleCronField(original, "minute", { mode: "values", values: [15, 45] });

    expect(original.minute).toEqual({ mode: "values", values: [0] });
    expect(serializeScheduleCron(updated)).toBe("15,45 8 * * 1,2,3,4,5");
  });

  it("rejects malformed expressions and empty value selections", () => {
    expect(() => parseScheduleCron("0 8 * *")).toThrow();
    for (const expression of ["-5 * * * *", "0- * * * *", "1e0 * * * *", "0xA * * * *"]) {
      expect(() => parseScheduleCron(expression)).toThrow();
    }
    expect(() => serializeScheduleCron({
      minute: { mode: "values", values: [] },
      hour: { mode: "any", values: [] },
      day: { mode: "any", values: [] },
      month: { mode: "any", values: [] },
      weekday: { mode: "any", values: [] },
    })).toThrow();
  });
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("formatScheduleCronField", () => {
  it("任意 / 已选 / 空选三种读数", () => {
    expect(formatScheduleCronField({ mode: "any", values: [] })).toBe("*");
    expect(formatScheduleCronField({ mode: "values", values: [1, 15] })).toBe("1,15");
    expect(formatScheduleCronField({ mode: "values", values: [] })).toBe("?");
  });
});

describe("describeScheduleCron", () => {
  it("常用模式成句", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("工作日 09:00");
    expect(describeCron("0 9 * * *")).toBe("每天 09:00");
    expect(describeCron("30 * * * *")).toBe("每小时 :30");
    expect(describeCron("* * * * *")).toBe("每分钟");
    expect(describeCron("0 18 * * 5")).toBe("每周五 18:00");
  });

  it("时间组合 ≤4 全部展开，超过回落原始表达式", () => {
    expect(describeCron("0,30 9,18 * * 1-5")).toBe("工作日 09:00、09:30、18:00、18:30");
    expect(describeCron("0,15,30,45 9,10 * * *")).toBe("0,15,30,45 9,10 * * *");
  });

  it("日期限定：几号 / 星期多选 / 月前缀 / 并集语义 / 全周", () => {
    expect(describeCron("0 9 1,15 * *")).toBe("每月 1、15 号 09:00");
    expect(describeCron("0 9 * * 0,2")).toBe("每周日、周二 09:00");
    expect(describeCron("0 9 * 3 *")).toBe("3 月 每天 09:00");
    expect(describeCron("0 9 1 * 1")).toBe("每周一或每月 1 号 09:00");
    expect(describeCron("0 9 * * 0-6")).toBe("每天 09:00");
  });

  it("每小时/每分钟不前缀每天；分任意×时有值成句（hourly 镜像）", () => {
    expect(describeCron("15,45 * * * *")).toBe("每小时 :15、45");
    expect(describeCron("15,45 * 1 * *")).toBe("每月 1 号 每小时 :15、45");
    expect(describeCron("* 9 * * *")).toBe("每天 09 点的每分钟");
    expect(describeCron("* 10,14 * * 1-5")).toBe("工作日 10、14 点的每分钟");
    // 用户实例：小时 6 项截断加省略号
    expect(describeCron("* 10,14,17,18,19,20 * * 1,2,3,4,5")).toBe("工作日 10、14、17、18… 点的每分钟");
  });

  it("令牌列表超过 4 项截断加省略号", () => {
    expect(describeCron("0 9 * * 0,1,2,3,4")).toBe("每周日、周一、周二、周三… 09:00");
  });

  it("有字段空选时返回 null（空选警示态）", () => {
    const cron = parseScheduleCron("0 9 * * 1-5");
    expect(describeScheduleCron({ ...cron, minute: { mode: "values", values: [] } }, t)).toBeNull();
  });
});

describe("nextScheduleRuns", () => {
  it("跳过周末命中工作日", () => {
    // 2026-11-27 是周五：18:00 起下一个工作日早晨是 11-30（周一）、12-01（周二）
    const runs = nextScheduleRuns("0 9 * * 1-5", 2, new Date(2026, 10, 27, 18, 0));
    expect(runs.map((d) => d.getTime())).toEqual([
      new Date(2026, 10, 30, 9, 0).getTime(),
      new Date(2026, 11, 1, 9, 0).getTime(),
    ]);
  });

  it("每小时与每分钟", () => {
    expect(nextScheduleRuns("30 * * * *", 2, new Date(2026, 10, 27, 12, 5)).map((d) => d.getTime()))
      .toEqual([new Date(2026, 10, 27, 12, 30).getTime(), new Date(2026, 10, 27, 13, 30).getTime()]);
    expect(nextScheduleRuns("* * * * *", 1, new Date(2026, 10, 27, 12, 5, 30)).map((d) => d.getTime()))
      .toEqual([new Date(2026, 10, 27, 12, 6).getTime()]);
  });

  it("日与周同时受限取并集", () => {
    // 2026-11-27 周五 12:00：1 号（周二 12-01）先到，其次下一个周五（12-04）
    const runs = nextScheduleRuns("0 9 1 * 5", 2, new Date(2026, 10, 27, 12, 0));
    expect(runs.map((d) => d.getTime())).toEqual([
      new Date(2026, 11, 1, 9, 0).getTime(),
      new Date(2026, 11, 4, 9, 0).getTime(),
    ]);
  });
});

describe("formatScheduleNextRun", () => {
  it("今天 / 明天 / 今年 / 跨年措辞", () => {
    const now = new Date();
    const lateToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 45);
    if (lateToday.getTime() > now.getTime()) {
      expect(formatScheduleNextRun(lateToday, t)).toBe("今天 23:45");
    }
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 5);
    expect(formatScheduleNextRun(tomorrow, t)).toBe("明天 08:05");
    expect(formatScheduleNextRun(new Date(now.getFullYear(), 11, 25, 9, 0), t)).toBe("12-25 09:00");
    expect(formatScheduleNextRun(new Date(now.getFullYear() + 1, 0, 3, 8, 0), t))
      .toBe(`${now.getFullYear() + 1}-01-03`);
  });
});
