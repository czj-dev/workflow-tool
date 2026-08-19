# 内置变量统一管理 设计

## 背景

`${VAR}` 展开目前由 `runner.Expand`（`internal/runner/expand.go`）处理，查找顺序是 params → 环境变量。`ADB_SERIAL` 名义上被当作"内置变量"用（`adb.ADBRunner` 里有专门的 `resolveSerial` 兜底到 `device.Service.ResolveActive`），但这条逻辑只在 `command.adb.operation` 形态生效；`command.shell`/`script` 形态里写 `${ADB_SERIAL}` 时，`Expand` 只查 params/环境变量，查不到就保留原样——UI 选中的激活设备传不到 shell 脚本里，这是现有 bug。

新增需求：提供 `CURRENT_DATE`（`yyyyMMdd`）、`CURRENT_TIME`（毫秒时间戳）两个内置变量，典型用法 `${OUTPUT_DIR}${CURRENT_TIME}.png` 给文件名加时间戳防覆盖。

顺带把 `ADB_SERIAL` 也纳入同一套内置变量机制，修复上述 shell 域 bug。

## 目标

1. 新增 `internal/builtinvars` 包，统一注册表管理所有内置变量（`CURRENT_DATE`/`CURRENT_TIME`/`ADB_SERIAL`），为以后新增内置变量提供单一落点。
2. `runner.Expand` 支持查内置变量注册表，新变量对 shell/script/adb/llm 四种动作形态、以及 workflow 的 step/env 全部生效。
3. 修复 `ADB_SERIAL` 在 shell 域取不到 UI 激活设备的 bug：注册表统一后，`${ADB_SERIAL}` 在任何形态里都能解析到当前激活设备。

## 非目标

- 不支持自定义时间格式化语法（如 `${CURRENT_TIME:fmt}`）——`CURRENT_DATE`/`CURRENT_TIME` 格式固定。
- 不改变 `config.yaml` 显式覆盖 `ADB_SERIAL` 的现有行为（仍然优先于内置变量兜底）。
- 不修改 `ADBRunner` 内部现有的在线校验/失效重解析逻辑（`resolveSerial`/`IsReady`），只是让 shell 域也能触达同一份兜底能力。

## 变量清单

| 变量 | 值 | 说明 |
|---|---|---|
| `CURRENT_DATE` | `time.Now().Format("20060102")` | 当天日期，8 位数字，文件名安全 |
| `CURRENT_TIME` | `strconv.FormatInt(time.Now().UnixMilli(), 10)` | 完整毫秒时间戳，纯数字 |
| `ADB_SERIAL` | `device.Service.ResolveActive(ctx)` 的结果 | 当前激活设备 serial；无设备时该变量视为未命中 |

同一次 `Expand` 调用内 `CURRENT_DATE`/`CURRENT_TIME` 各自独立取值（各调一次 `time.Now()`），不保证同一进程内多次调用完全一致，微小误差可接受（无并发原子性要求）。

## 架构

```
internal/builtinvars/           新包，无 Wails 依赖，可单测
  builtinvars.go   Registry struct + Resolve(ctx, name) (string, bool)

internal/runner/expand.go       Expand 签名新增 builtins 参数
  Expand(ctx, s, vars, builtins) string
  查找顺序：vars（params/merged） → builtins.Resolve → 环境变量 → 保留原样+warning

internal/adb/runner.go          resolveSerial 的 paramSerial 兜底源
  改为：params 里没有显式 ADB_SERIAL 时，走 builtins.Resolve 兜底
  （而不是各自重复实现 ResolveActive 调用）

internal/api/api.go             Service 持有 *builtinvars.Registry
  New() 里用 svc.dev 构造，所有 Expand 调用点改传它
```

### 为什么单独建包而不是塞进 `runner`

`ADB_SERIAL` 的解析依赖 `device.Service`（`adb` 域），如果把这个依赖写进 `runner` 包，会造成 `runner → adb/device` 的依赖方向，而 `adb.ADBRunner` 本身实现的是 `runner.Runner` 接口（`adb → runner`），会形成循环依赖。`builtinvars` 作为独立包，只依赖一个最小接口（`ResolveActive(ctx) (string, error)`），`runner` 和 `adb` 都可以安全依赖它，不产生环。

### Registry 设计

```go
package builtinvars

type DeviceResolver interface {
    ResolveActive(ctx context.Context) (string, error)
}

type Registry struct {
    dev DeviceResolver // 可为 nil（无设备服务的场景，如纯单测）
}

func New(dev DeviceResolver) *Registry

// Resolve 返回 name 对应的内置变量值。ok=false 表示 name 不是已注册的内置变量，
// 或者是但当前解析失败（如无在线设备）——两种情况调用方都应继续走下一优先级（环境变量）。
func (r *Registry) Resolve(ctx context.Context, name string) (string, bool)
```

`nil *Registry` 需要安全：`Resolve` 在 receiver 为 nil 时直接返回 `("", false)`，兼容现有测试里不传 builtins 的调用点（测试可传 `nil`）。

### Expand 签名变更

```go
// 之前
func Expand(s string, vars map[string]any) string

// 之后
func Expand(ctx context.Context, s string, vars map[string]any, builtins *builtinvars.Registry) string
```

查找顺序变为：
1. `vars`（params/merged，字符串值）
2. `builtins.Resolve(ctx, name)`（内置变量注册表；`builtins` 为 nil 时跳过）
3. `os.LookupEnv(name)`（环境变量）
4. 保留 `${VAR}` 原样 + warning log

`ExpandMap`/`ExpandParams` 同步新增 `ctx`/`builtins` 参数，透传给内部的 `Expand` 调用。

### 调用点改动清单

| 文件 | 函数 | 改动 |
|---|---|---|
| `internal/runner/expand.go` | `Expand`/`ExpandMap`/`ExpandParams` | 签名新增 `ctx, builtins` |
| `internal/runner/shell_runner.go:35-38` | `Run` | `Shell`/`Script`/`Cwd`/`Env` 四处 `Expand`/`ExpandMap` 调用透传 `ctx, r.Builtins`（`ShellConfig` 新增 `Builtins *builtinvars.Registry` 字段） |
| `internal/actionrun/build.go:90` | `buildLLM` | `Expand` 调用透传 `ctx, builtins`（`Options` 新增 `Builtins *builtinvars.Registry` 字段） |
| `internal/api/run.go:97,104` | `execute` | `ExpandParams`/`Expand` 调用透传 `ctx, s.builtins` |
| `internal/api/workflows.go:185,191,230,239` | `makeShellRun`/`buildActionRunParams` | 同上，透传 `ctx, s.builtins` |
| `internal/adb/runner.go:53` | `Run` | `strParam` 取不到值时改为 `builtins.Resolve(ctx, "ADB_SERIAL")` 兜底 |

`runner.Runner` 接口本身的 `Run(ctx, params, emit)` 签名不变——`builtins` 通过各 Runner 的 `Cfg`/字段注入（构造时传入，不进 `Run` 的参数列表），与现有 `ShellConfig`/`ADBRunner` 字段注入模式一致。

### ADBRunner 改动细节

```go
// internal/adb/runner.go
type ADBRunner struct {
    Operation    string
    Timeout      time.Duration
    Dev          deviceResolver
    ResolvePaths func() binary.Paths
    Control      chan any
    Builtins     *builtinvars.Registry // 新增
}

func (r *ADBRunner) Run(ctx context.Context, params map[string]any, emit runner.EmitFunc) runner.Result {
    ...
    serial := resolveSerial(ctx, r.Dev, r.Builtins, strParam(params, "ADB_SERIAL"))
    ...
}

func resolveSerial(ctx context.Context, dev deviceResolver, builtins *builtinvars.Registry, paramSerial string) string {
    if paramSerial != "" && dev != nil && dev.IsReady(ctx, paramSerial) {
        return paramSerial // config.yaml 显式覆盖，仍是最高优先级
    }
    if builtins != nil {
        if s, ok := builtins.Resolve(ctx, "ADB_SERIAL"); ok {
            return s
        }
    }
    if dev != nil {
        if s, err := dev.ResolveActive(ctx); err == nil && s != "" {
            return s
        }
    }
    return paramSerial
}
```

注：`ADBRunner` 已经持有 `Dev`（`device.Service`），`Builtins.Resolve("ADB_SERIAL")` 内部也是调 `Dev.ResolveActive`——两者语义等价，这里保留 `dev.ResolveActive` 直接调用作为双重兜底并不必要；但为了让 `resolveSerial` 的现有单测（`internal/adb/runner_test.go`，直接构造 `ADBRunner{Dev: mockDev}` 不传 `Builtins`）继续通过，`Builtins` 为 nil 时必须跳过、直接走 `dev.ResolveActive`——这也是"内置变量只统一注册表/命名空间，不统一状态持有"的具体体现：`ADBRunner` 自己的 `Dev` 兜底路径保留不动，`Builtins` 只是给 shell 域用的新增能力。

## Service 改动

```go
// internal/api/api.go
type Service struct {
    ...
    builtins *builtinvars.Registry // 新增
}

func New(...) *Service {
    ...
    svc.dev = device.NewService(svc.binPaths)
    svc.builtins = builtinvars.New(svc.dev) // device.Service 满足 DeviceResolver 接口
    svc.runDeps = actionrun.Deps{BaseDir: baseDir, ADBPaths: svc.binPaths, ADBDevice: svc.dev, Builtins: svc.builtins}
    ...
}
```

`actionrun.Deps` 新增 `Builtins *builtinvars.Registry` 字段，`actionrun.Build` 把它传给构造出的 `ShellRunner`/`ADBRunner`/`LLMRunner`。

## 测试策略

- `internal/builtinvars/builtinvars_test.go`：单测 `Registry.Resolve` 三个变量（`CURRENT_DATE`/`CURRENT_TIME` 格式校验、`ADB_SERIAL` 走 mock `DeviceResolver`、未知变量名返回 `ok=false`、nil registry 返回 `ok=false`）。
- `internal/runner/expand_test.go`：新增用例验证 `Expand` 在 params 未命中时查 builtins，builtins 未命中再查环境变量（优先级三层验证）；现有用例签名更新加 `context.Background(), nil`（不涉及 builtins 的用例传 nil）。
- `internal/adb/runner_test.go`：新增用例验证 shell 域场景不适用（该文件测的是 ADBRunner），但需要更新现有 `resolveSerial` 调用签名，并新增"params 无值、builtins 命中"的用例。
- 手动验证：新建一个 `command.shell` 测试动作，`Shell: "echo ${ADB_SERIAL} ${CURRENT_DATE} ${CURRENT_TIME}"`，UI 选中设备后运行，确认三个变量都被替换为真实值（而非保留 `${...}` 原样）。

## 文档同步

- `docs/action.md` 的"变量替换"章节（第 92-102 行）需要新增一段说明内置变量（列出 `CURRENT_DATE`/`CURRENT_TIME`/`ADB_SERIAL`），并更新优先级列表为：
  1. 动作参数
  2. 全局配置（`config.yaml`）
  3. 内置变量（`CURRENT_DATE`/`CURRENT_TIME`/`ADB_SERIAL`）
  4. 环境变量
