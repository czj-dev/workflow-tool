import { beforeEach, describe, expect, it } from "vitest";
import i18n from "./index";

// i18n 是单例（模块加载时 init 一次），测试间状态会泄漏，
// 故每个测试前重置语言为 zh 并清空 localStorage，保证隔离。
describe("i18n", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("zh");
  });

  it("中文文案正确", () => {
    expect(i18n.language).toMatch(/^zh/);
    expect(i18n.t("main.stop")).toBe("停止");
  });

  it("切换到 en 后文案变化", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("main.stop")).toBe("Stop");
  });

  it("支持插值", () => {
    expect(i18n.t("output.exitLine", { exitCode: 0, err: "" })).toBe(
      "--- 退出码 0 ---"
    );
  });
});
