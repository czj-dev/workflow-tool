# 实时日志场景预设补全

## 目标与范围

在 `actions/adb-logcat-stream.yaml` 的现有 `presets` 中增加“VTS / TopQuery”和“导航多轮”两个预设，覆盖 `xdzs-speech` 近期高频问题的诊断日志。不新增 action，不改变日志采集、设备配置、文件导出或现有预设。

## 预设定义

两个预设都使用 `LEVEL: V`、空 `PACKAGE`（保留跨进程日志），以空格分隔的 `TAG` 列表声明候选 Tag，并显式设置 `FILTER: ""`、`INCLUDE: ""`、`EXCLUDE: ""`，防止全局配置中的同名过滤参数覆盖或收窄预设规则。后端和前端的现有规则映射会将同一 `tag` key 的多个 token 按 OR 求值；`XLog` 自动添加的 `DVR_` 前缀写在每个 Tag 中。无需为简单 Tag 列表额外写 `FILTER` JSON。

| 预设 | TAG | 排查范围 |
| --- | --- | --- |
| VTS / TopQuery | `DVR_TopQueryInterceptor DVR_TopQueryUtil DVR_VtsManager DVR_VtsInterveneMatchImpl` | TopQuery 入口、可见即可说命中和控件筛选 |
| 导航多轮 | `DVR_NaviMultiRoundRule DVR_NavigationFlowDeviceModule DVR_ProtocolConverterManager DVR_TinnoveIpc` | 导航轮次、POI 状态、协议转换及下发 |

## 数据流与失败行为

预设由现有 YAML 加载，用户在实时日志页点击后应用规则；运行中的 `logcat-stream` 重筛最近的 raw ring 并继续按新规则展示增量日志。Tag 没有产生日志时展示现有空态，不修改设备状态，也不自动清空缓冲。预设加载失败沿用现有动作 YAML 校验与错误展示路径。

## 验证

运行现有 action 加载/校验测试，并针对新增两个预设检查规则能匹配各自目标 Tag、不会匹配无关 Tag；同时确认不影响现有预设。无需新依赖、后端接口、前端组件或新的采集流程。
