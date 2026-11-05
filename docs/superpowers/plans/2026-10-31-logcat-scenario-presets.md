# 实时日志场景预设补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有实时日志 action 中增加 VTS / TopQuery 与导航多轮两个可直接应用的预设。

**Architecture:** 只增加 `adb-logcat-stream.yaml` 的预设参数，由现有 `RuleFromParamsExt` 将空格分隔的 Tag 映射为同 key OR 规则。测试经 `registry.Load` 读取实际 YAML，再经规则编译验证命中与排除。

**Tech Stack:** YAML、Go 标准测试、现有 registry / logcat 包。

## Global Constraints

- `LEVEL: V`，`PACKAGE: ""`，显式清空 `FILTER`、`INCLUDE`、`EXCLUDE` 以覆盖全局配置；不改现有预设、设备状态或采集与导出流程。
- 不新增依赖、运行时接口或前端组件；不执行 git 提交、分支、推送。

---

### Task 1: 增加并验证两条日志预设

**Files:**
- Modify: `actions/adb-logcat-stream.yaml:46`，在已有预设之后追加两条。
- Modify: `internal/api/actions_validate_test.go:40`，增加针对实际 YAML 的规则验证测试。
- Reference: `docs/superpowers/specs/2026-10-31-logcat-scenario-presets-design.md`。

**Interfaces:**
- Consumes: `registry.Load(dir, baseDir)` 与 `logcat.RuleFromParamsExt(level, tags, include, exclude, pkg, filter)`、`logcat.CompileRule(rule)`、`(*logcat.CompiledRule).Allow(*logcat.Entry)`。
- Produces: YAML 中的 `VTS / TopQuery`、`导航多轮` 两个预设；不新增 Go 公共接口。

- [x] **Step 1: 写失败测试。** 在 `internal/api/actions_validate_test.go` 引入 `strings` 与 `workflow-tool/internal/adb/logcat`，新增：

```go
func TestLogcatScenarioPresets(t *testing.T) {
    reg := registry.Load(filepath.Join("..", "..", "actions"), filepath.Join("..", ".."))
    action, ok := reg.Actions["adb-logcat-stream"]
    if !ok { t.Fatal("adb-logcat-stream not loaded") }
    cases := []struct {
        name string
        tags []string
    }{
        {"VTS / TopQuery", []string{"DVR_TopQueryInterceptor", "DVR_TopQueryUtil", "DVR_VtsManager", "DVR_VtsInterveneMatchImpl"}},
        {"导航多轮", []string{"DVR_NaviMultiRoundRule", "DVR_NavigationFlowDeviceModule", "DVR_ProtocolConverterManager", "DVR_TinnoveIpc"}},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            var values map[string]string
            for _, preset := range action.Def.Presets {
                if preset.Name == tc.name { values = preset.Values; break }
            }
            if values == nil { t.Fatalf("missing preset %q", tc.name) }
            if values["LEVEL"] != "V" || values["PACKAGE"] != "" { t.Fatalf("unexpected level/package: %v", values) }
            for _, key := range []string{"FILTER", "INCLUDE", "EXCLUDE"} {
                if value, ok := values[key]; !ok || value != "" { t.Errorf("%s must explicitly clear global config", key) }
            }
            if strings.Join(strings.Fields(values["TAG"]), " ") != strings.Join(tc.tags, " ") { t.Fatalf("unexpected tags: %q", values["TAG"]) }
            rule := logcat.RuleFromParamsExt(values["LEVEL"], values["TAG"], values["INCLUDE"], values["EXCLUDE"], values["PACKAGE"], values["FILTER"])
            compiled, err := logcat.CompileRule(rule)
            if err != nil { t.Fatal(err) }
            for _, tag := range tc.tags {
                if !compiled.Allow(&logcat.Entry{Level: "D", Tag: tag}) { t.Errorf("does not match %s", tag) }
            }
            if compiled.Allow(&logcat.Entry{Level: "D", Tag: "UnrelatedTag", Message: tc.tags[0]}) { t.Error("target tag in message matched unrelated tag") }
        })
    }
}
```

- [x] **Step 2: 确认 RED。** 运行 `go test ./internal/api -run TestLogcatScenarioPresets -count=1`；期望两条子测试都报 `missing preset`。

- [x] **Step 3: 最小实现。** 在 `actions/adb-logcat-stream.yaml` 末尾追加：

```yaml
  - name: VTS / TopQuery
    description: TopQuery 入口与可见即可说命中、控件筛选
    values: {EXCLUDE: "", INCLUDE: "", FILTER: "", LEVEL: V, PACKAGE: "", TAG: "DVR_TopQueryInterceptor DVR_TopQueryUtil DVR_VtsManager DVR_VtsInterveneMatchImpl"}
  - name: 导航多轮
    description: 导航轮次、POI 状态、协议转换及下发
    values: {EXCLUDE: "", INCLUDE: "", FILTER: "", LEVEL: V, PACKAGE: "", TAG: "DVR_NaviMultiRoundRule DVR_NavigationFlowDeviceModule DVR_ProtocolConverterManager DVR_TinnoveIpc"}
```

- [x] **Step 4: 确认 GREEN 并验证原有行为。** 运行 `gofmt -w internal/api/actions_validate_test.go`，`go test ./internal/api ./internal/adb/logcat ./internal/registry -count=1`，再运行 `go test -race ./internal/api ./internal/adb/logcat ./internal/registry -count=1`；期望均通过。运行 `git diff --check`，期望无空白错误。检查 `git diff -- actions/adb-logcat-stream.yaml internal/api/actions_validate_test.go`，确认未修改已有预设。
