import { describe, expect, it } from "vitest";
import { parseScheduleCron, serializeScheduleCron, updateScheduleCronField } from "./scheduleCron";

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
