# 通用定时任务面板设计规格

> 本规格基于已确认的 A 版“运维表格型”原型，描述 workflow-tool 的通用 Scheduler 面板。Scheduler 不绑定 LLM，可定时执行 action 或 workflow。
>
> **修订（2026-11-24）**：本规格的以下非目标已被 ADR-0005 与《AI 体系独立与调度接入设计规格》（`2026-11-24-ai-system-and-schedules-design.md`）修订，以新规格为准：
> - AI 任务成为第三种调度目标，取代「不绑定 LLM」。
> - 睡眠错过的时刻会留档，并可按调度的补跑开关补跑，取代「不实现睡眠错过补跑」。
> - 调度到点与立即运行的运行交给独立执行器（跨进程），取代「不实现跨进程调度」；跨机器仍不在范围内。
> - 调度到点撞上正在运行的目标记为跳过，不再是「启动失败」。
> - 完整运行日志落入运行记录，取代「不把完整运行日志复制到 Scheduler 历史」。
>
> 仍然保留的非目标：自然语言 Cron 编辑器、跨机器调度、不退役现有 launchd。

## 目标

在 workflow-tool 中增加通用定时任务管理能力：用户可以在 GUI 中查看、创建、编辑、启用/停用、立即执行和删除定时任务；GUI 常驻期间按 Cron 触发 action/workflow，运行输出继续复用现有事件流。

## 已确认的界面位置

Scheduler 入口位于左侧边栏的 **Config** 分组，与以下入口并列：

- 片段
- 全局配置
- 定时任务
- 设置

Scheduler 不放在 Workspace 的 Actions / Workflows 一级分组中，因为它是运行配置与自动化策略，而不是一种执行目标。

## 用户界面

采用 A 版运维表格型布局：

- 页面标题：定时任务
- 顶部操作：刷新、新建任务
- 统计摘要：全部任务、已启用、正在运行、最近成功
- 筛选：全部任务、已启用、已停用
- 搜索：按任务名称、任务 ID、目标 ID 搜索
- 表格列：状态、任务、执行目标、Cron、下次执行、最近结果、操作
- 编辑抽屉：任务名称、启用状态、目标类型、目标选择、Cron、参数、保存、立即执行、删除

目标类型只有两种：`action` 与 `workflow`。选择目标后，参数编辑复用现有 `ParamSpec` / 参数字段渲染能力，不另造一套参数控件。

## 数据模型

`schedules.yaml` 是持久化真相源，结构如下：

```yaml
schedules:
  - id: bg202-hourly
    name: BG202 巡检
    enabled: true
    cron: "7 10-19 * * 1-5"
    action: bg202-patrol
    params:
      device: active
```

`action` 与 `workflow` 必须恰好存在一个。`enabled` 缺省时按启用处理，以兼容手写旧配置。`params` 缺省为空对象。

后端向前端暴露 JSON-safe DTO，不直接暴露内部 Cron 解析结构：

- `ScheduleItem`：ID、Name、Enabled、Cron、TargetKind、TargetID、Params、NextRun、Running、LastRun
- `LastRun`：Status、StartedAt、FinishedAt、ExitCode、Duration、Error
- `ScheduleListResult`：Schedules、Errors

最近一次运行状态保存在当前 GUI 进程内；进程重启后没有运行记录时显示“未执行”。调度配置本身跨重启保留在 `schedules.yaml`。

## 后端边界

### `internal/schedule`

纯 Go 包，不依赖 Wails 或 `internal/api`，负责：

- 5 字段 Cron 解析、校验和匹配
- schedules.yaml 解析、校验和序列化所需模型
- enabled 过滤
- 30 秒 tick 调度与分钟去重
- 通过注入的 TriggerFunc 触发目标

Cron 支持 `*`、固定值、范围、逗号列表；暂不支持 `*/n` 步进和名称别名。GUI 睡眠期间错过的任务不补跑。

### `internal/api.Service`

Service 持有调度配置路径、调度器实例和运行状态，并提供 Wails 方法：

- `ListSchedules() ScheduleListResult`
- `SaveSchedule(input ScheduleInput) (ScheduleListResult, error)`
- `DeleteSchedule(id string) (ScheduleListResult, error)`
- `SetScheduleEnabled(id string, enabled bool) (ScheduleListResult, error)`
- `RunScheduleNow(id string) error`

Service 负责：

- 校验 ID、名称、Cron、目标引用和参数
- 原子更新内存配置与 `schedules.yaml`
- 保存后 reload/reconcile 调度器，无需重启
- 将定时执行和立即执行转发到现有 `RunAction` / `RunWorkflow`
- 维护 schedule ID 到目标运行的关联
- 在 action/workflow 完成时更新该 schedule 的 `LastRun`
- 发出调度状态变化事件供前端实时刷新

不在 Scheduler 面板中复制 action/workflow 的运行实现。调度触发必须经过现有运行入口，以保留参数展开、运行锁、取消和输出事件行为。

## 运行状态与事件

调度器的“最近结果”只记录调度任务维度，不替代 action/workflow 输出事件：

- 目标输出继续使用 `action:<id>:output` / `workflow:<id>:output`
- 目标完成继续使用现有 done 事件
- 新增 schedule 状态事件，携带 schedule ID、运行状态和 LastRun
- 面板订阅状态事件，更新表格中的运行中、成功、失败、退出码和耗时

同一 action/workflow 的手动执行与调度执行继续共享现有并发拒绝规则；调度到点时若目标正在运行，记录启动失败，不排队。

## 错误处理

- schedules.yaml 不存在：按空列表启动，首次保存时创建
- YAML 解析失败：服务启动时记录错误，面板展示加载错误，不启动非法条目
- 引用未知 action/workflow：保存拒绝，返回带 schedule ID 和目标 ID 的错误
- Cron 非法：保存拒绝，错误定位到字段
- 重复 ID：保存拒绝
- 删除不存在 ID：返回明确错误
- 定时触发启动失败：更新最近结果为失败并记录错误，不阻塞其他 schedule
- 文件写入失败：不替换当前内存配置，返回错误

## 前端接入

- `RunnerView` 增加 `scheduler`
- `OutputPanel` 增加 Scheduler 面板分支
- `AppSidebar` 在 Config 分组新增入口，仅调用 `setView("scheduler")`
- `ActionRunnerProvider` 负责加载 schedules、保存/删除/启停/立即执行调用，以及调度事件订阅
- Scheduler 面板自身维护抽屉开合、筛选、搜索和编辑草稿
- 新增中文和英文 i18n 文案

## 测试验收

### Go

- Cron 解析、边界和匹配
- schedules.yaml 读取、默认值和字段互斥校验
- action/workflow 引用校验
- 保存、删除、启停和非法输入不落盘
- 调度分钟去重、禁用过滤和目标触发
- action/workflow 完成后 LastRun 更新
- 并发运行拒绝不排队

### 前端

- Config 分组显示 Scheduler 入口，点击进入 scheduler view
- 列表显示统计、筛选和搜索结果
- 新建/编辑抽屉切换 action/workflow 并渲染目标参数
- 保存、删除、启停和立即执行刷新列表
- 状态事件将运行中、成功和失败显示在对应行
- 小屏幕不产生横向页面溢出

## 非目标

- 不绑定 LLM；LLM 只是可被调度的 action 形态之一
- 不实现自然语言 Cron 编辑器
- 不实现睡眠错过补跑
- 不实现跨进程、跨机器调度
- 不把完整运行日志复制到 Scheduler 历史；输出仍在现有 action/workflow 视图中查看
- 不退役现有 launchd，除非另行确认
