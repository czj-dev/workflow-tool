// PROTOTYPE（一次性）：内存桩的数据源。config.yaml / fragments.yaml 原样抄录（含真实的多行、
// 正则、缺失变量 ${PATH} ${TEXT} ${LOG_FILE}），actions / workflows / ai 只抄侧栏要用的标题行。
// 目的是让原型跑在真实数据的体量与形状上，而不是几条编造的样例。
type Item = { id: string; title: string; description: string; icon: string };

export const STUB_CONFIG: Record<string, string> = {
  DOCS: "${USER}/Documents",
  LOGS_DIR: "${DOCS}/Logs",
  OUTPUT_DIR: "${DOCS}/docs",
  USER: "/Users/v_chenzhaojun",
  VOICE_DEBUG_OUTPUT: "${XDZS_SPEECH_DIR}/app-vui/vr-app/build/outputs/apk/debug",
  VOICE_RELEASE_OUTPUT: "${XDZS_SPEECH_DIR}/app-vui/vr-app/build/outputs/apk/release",
  XDZS_RESROUCE_DIR: "${USER}/Project/baidu/asd-edc/xdzs-resrouce",
  XDZS_SPEECH_DIR: "${USER}/Project/baidu/asd-edc/xdzs-speech",
};

export interface StubFragment {
  title: string;
  content: string;
  tags: string[];
}

export const STUB_FRAGMENTS: StubFragment[] = [
  {
    title: "AIBOX 指令过滤",
    content:
      'lnav -c ":filter-in AiosGrpcClientImpl" -c ":filter-in R4Arbiter" -c ":filter-in ProtocolConverterManager"   -c  ":filter-in SemanticDispatcher:"  -c ":filter-in playTTsFullParams"    -q ',
    tags: ["Lanv", "AIBOX"],
  },
  {
    title: "AI-BOX Agent",
    content:
      'lnav -c ":filter-in SseAgentBridge" -c ":filter-in SseCarCommandProcessor" -c ":filter-in CarManualStreamAgentVM" -c ":filter-in TinnoveIpc"  -c ":filter-in CarManualStreamAgentScene" -c ":filter-in SseAgentStreamRouter"  -c ":filter-in R4Arbiter" -q ${PATH}',
    tags: ["Lanv", "AIBOX"],
  },
  { title: "Rg 过滤 ASR 所在文件", content: ' rg -lz "getAsrText: ${TEXT}"', tags: ["Rg"] },
  {
    title: "端状态",
    content:
      ' rg -z -M 500 --max-columns-preview "uploadContextState appId:1A7BB7ACC7AC6B8B8158C16853C8F77D"',
    tags: ["Rg"],
  },
  { title: "查找指定文本", content: 'rg -lz -M 200 --max-columns-preview "AiosGrpcClientImpl"', tags: ["Rg"] },
  {
    title: "全时免唤醒",
    content: [
      "adb shell settings put global tinnove_wakeup_switch  1",
      "adb shell settings put global tinnove_fulltime_wakeup_switch 1",
      "adb shell settings put global tinnove_continuous_conversation_duration 1",
      "adb shell am force-stop com.baidu.che.codriver",
    ].join("\n"),
    tags: ["adb"],
  },
  { title: "任务大师环境日志", content: "CUISkillHandler", tags: ["Log"] },
  { title: "中间识别结果", content: "name:asr.partial", tags: ["Log"] },
  {
    title: "常用链路查看",
    content:
      'lnav -c ":filter-in initService"  -c  ":filter-in SemanticDispatcher:"  -c  ":filter-in playTTsFullParams"    -q ${PATH}',
    tags: ["Lanv"],
  },
  {
    title: "梧桐日志预览平台",
    content:
      "https://portal.auto-pai.com/spm-data/#/browse?path=autopai-tlc/platform/C5181/log/${LOG_FILE}",
    tags: ["Link"],
  },
  { title: "App 信息上传", content: "DVR_CarAppInfoRequest.*?:|DVR_okhttp.OkHttpClient.*?:", tags: ["Log"] },
  {
    title: "Asr_sn_filter",
    content: String.raw`vrsdk_AsrEngine_\d+:\s+asrResultInfo\s+sn:\s*(\S+)\s+(offline|online)\s+asr:\s*(.+?)\s+(partial|final)_result(?:\s+(\S+))?\s*$`,
    tags: ["Rg"],
  },
  { title: "环境打印信息", content: " vrsdk_DcsEngine: setNetworkEnvConfig", tags: ["Log"] },
  { title: "车辆信号请求", content: "UploadAgentSignalRequest.*?:|DVR_okhttp.OkHttpClient.*?:", tags: ["Log"] },
  {
    title: "权限检测",
    content: [
      "adb shell appops get com.baidu.che.codriver RECORD_AUDIO ACCESS_FINE_LOCATION",
      'adb shell dumpsys package com.baidu.che.codriver | grep -E "RECORD_AUDIO|ACCESS_FINE_LOCATION" -A2',
    ].join("\n"),
    tags: ["adb"],
  },
  {
    title: "Asr_sn_filter_final",
    content: String.raw`vrsdk_AsrEngine_\d+:\s+asrResultInfo\s+sn:\s*(\S+)\s+(offline|online)\s+asr:\s*(.+?)\s+(final)_result(?:\s+(\S+))?\s*$`,
    tags: ["Log"],
  },
  {
    title: "档位  1：N，2：R,4：P,8：D",
    content: "adb shell dumpsys virtualcar_service inject-virtual-event 0x31400231 0 1",
    tags: ["adb"],
  },
  {
    title: "电源挡位  0x1 = LOCK, 0x2 = OFF,0x3 = ACC, 0x4 = ON, 0x5 = START",
    content: "adb shell dumpsys virtualcar_service inject-virtual-event 0x31400201 0 4",
    tags: ["adb"],
  },
  { title: "热词", content: "setHotWordWithCallBack - appId:", tags: ["Log"] },
];

const ACTIONS: Item[] = [
  { id: "adb-app-details", title: "应用详情", description: "查看应用版本号 / APK 大小 / 数据大小", icon: "hi:file" },
  { id: "adb-battery", title: "电池信息", description: "查看设备电池状况（dumpsys battery）", icon: "hi:car" },
  { id: "adb-broadcast", title: "发送广播", description: "am broadcast 发送广播（泛化自原 adb-query / adb-car-broadcast）", icon: "hi:radio" },
  { id: "adb-debug-activity", title: "拉起测试页面", description: "adb shell am start 指定 Activity", icon: "hi:test" },
  { id: "adb-delete-file", title: "删除设备文件", description: "⚠️ 破坏性操作：删除设备上的文件或目录（不可恢复），请确认路径无误", icon: "hi:cancel" },
  { id: "adb-device-info", title: "设备信息", description: "聚合设备画像：概览(型号/品牌/系统/VIN/分辨率/密度/IP/MAC) + 详情(车型标识/构建/芯片/OEM车机定制属性/序列号/CPU/内存/内核)", icon: "hi:settings" },
  { id: "adb-force-stop", title: "强制停止", description: "强制停止指定应用（am force-stop）", icon: "hi:cancel" },
  { id: "adb-foreground-activity", title: "前台信息", description: "一键查看前台 Activity、焦点窗口（多 display 分组）与 View 树（uiautomator 无障碍树），格式化报告", icon: "hi:test" },
  { id: "adb-input-text", title: "输入文本", description: "向设备输入文本；纯英文走 input text，含中文等非 ASCII 经 ADBKeyboard 输入法广播（未安装自动安装内嵌 APK）", icon: "hi:text" },
  { id: "adb-install", title: "安装 APK", description: "adb install 安装指定 APK 到激活设备（-r 覆盖安装，可选 -t 测试包 / -d 降级）", icon: "hi:package" },
  { id: "adb-keyevent", title: "模拟按键", description: "模拟设备按键（input keyevent），常用键见预设", icon: "hi:flash" },
  { id: "adb-list-files", title: "设备文件列表", description: "递归查看设备目录文件与属性（默认 /sdcard/，最多四层）", icon: "hi:folder" },
  { id: "adb-list-packages", title: "应用列表", description: "列出设备应用（user 第三方 / system 系统 / all 全部，合并 enabled/disabled 状态）", icon: "hi:package" },
  { id: "adb-logcat-stream", title: "实时日志", description: "实时流式 logcat（threadtime 结构化解析，按 Package/Level/Tag/关键字 过滤，手动停止）", icon: "hi:file" },
  { id: "adb-logcat", title: "抓取日志", description: "adb logcat 抓取到本地文件（threadtime 结构化解析，按 Package/Level/Tag/关键字 过滤，手动停止）", icon: "hi:file" },
  { id: "adb-prop", title: "属性读写", description: "getprop / setprop 读写系统属性（泛化自原 adb-debug-log）", icon: "hi:settings" },
  { id: "adb-pull-apk", title: "拉取 APK", description: "根据包名定位安装路径并 pull APK 到本地（pm path → adb pull）", icon: "hi:download" },
  { id: "adb-pull", title: "拉取文件", description: "从设备拉取文件到本地（进度推送、3 次重试、可取消）", icon: "hi:download" },
  { id: "adb-push-apk-libs", title: "推送 APK 的 lib", description: "解压 APK 的 lib 目录（删 armeabi-v7a，arm64-v8a 重命名为 arm64）并 push 到设备目录（系统应用原生库场景）", icon: "hi:upload" },
  { id: "adb-push", title: "推送文件", description: "推送本地文件到设备（解析 [NN%] 进度，3 次重试，可取消）", icon: "hi:upload" },
  { id: "adb-reboot", title: "重启设备", description: "⚠️ 破坏性操作：重启设备到指定模式，设备会断开 adb 连接", icon: "hi:flash" },
  { id: "adb-scrcpy", title: "投屏", description: "使用 scrcpy 投屏 Android 设备（结构化选项，手动停止；可同步录制）", icon: "hi:play" },
  { id: "adb-screenshot", title: "截屏", description: "截取设备屏幕并保存为本地 PNG（adb exec-out screencap -p）", icon: "hi:camera" },
  { id: "adb-uninstall", title: "卸载应用", description: "卸载指定应用（支持批量，空格分隔多个包名）", icon: "hi:cancel" },
  { id: "adb-wifi", title: "WiFi 开关", description: "开启 / 关闭设备 WiFi（svc wifi）", icon: "hi:radio" },
  { id: "demo-echo", title: "演示回显", description: "纯 echo，无外部依赖；用于 workflow action step 引用形态的演示", icon: "hi:test" },
  { id: "demo-script-node", title: "验收: script .js 路由", description: "script: ./scripts/test/hello.js——按 .js 扩展名路由到 node", icon: "hi:test" },
  { id: "demo-script-python", title: "验收: script .py 路由", description: "script: ./scripts/test/hello.py——按 .py 扩展名路由到 python（-u 无缓冲）", icon: "hi:test" },
  { id: "demo-shell-bash", title: "验收: bash 默认形态", description: "验证默认 bash：多行块 + ${VAR} 展开 + ##[output] 协议 + 退出码 0（预期成功）", icon: "hi:test" },
  { id: "demo-shell-failfast", title: "验收: -eo pipefail 快速失败", description: "预期失败：第 2 行 exit 3，-e 生效后续行不执行、exit_code=3（用于验证错误处理语义统一）", icon: "hi:test" },
  { id: "demo-shell-pwsh", title: "验收: pwsh 退出码传播", description: "显式 shell: pwsh；原生命令(cmd /c exit 5)非零退出码应经 WrapTail 传播为脚本退出码（预期 exit_code=5；无 pwsh 的环境会报错属预期）", icon: "hi:test" },
  { id: "log-json-extract", title: "日志 JSON 提取转中文", description: "粘贴一行日志，自动分离前置文本与 JSON 部分，JSON 递归展开内嵌转义字符串并还原中文（依赖 jq）", icon: "hi:test" },
  { id: "log-spm-download", title: "SPM 下载 zip 内文件", description: "从 SPM 数据平台的 zip 包中按路径片段匹配文件并保存到本地（命中多个则全部下载，无需认证）", icon: "hi:download" },
  { id: "xdzs-build-app", title: "编译 vr-app", description: "在 xdzs-speech 项目根执行 gradlew vr-app:assemble<Variant>", icon: "hi:package" },
  { id: "xdzs-device-init", title: "语音权限赋予", description: "adb root/remount/setenforce + 授予 codriver & voicesetting 权限", icon: "hi:settings" },
  { id: "xdzs-protocol-query", title: "语音协议查询", description: "tinnove-ai 语义查询 → jq 格式化语义 → extract_wt_protocol.sh --adb 输出车机广播命令", icon: "hi:voice" },
  { id: "xdzs-sync-time", title: "同步电脑时间到安卓", description: "adb root + 设置设备系统时间为电脑当前时间并同步硬件时钟", icon: "hi:clock" },
];

const WORKFLOWS: Item[] = [
  { id: "adb-device-snapshot", title: "设备画像", description: "设备信息 → 电池信息 → 第三方应用列表，一次性出设备快照", icon: "hi:workflow" },
  { id: "demo-all-features", title: "演示: 全功能工作流", description: "覆盖 workflow 全部能力：params 四类型、action/sleep/shell 三形态、env、${{ }} 在 shell/params/env 三处展开、if 条件、outputs 引用、SKIPPED、retry、continue_on_error", icon: "hi:workflow" },
  { id: "demo-shell-acceptance", title: "验收: GHA shell 端到端", description: "run(bash)+output → pwsh 退出码传播(continue_on_error 容错无 pwsh 环境) → if 引用 outputs → script python action → sleep → 收尾", icon: "hi:workflow" },
  { id: "xdzs-clean-reinstall", title: "推送覆盖应用", description: "强制停止 → 清除数据 → 卸载 → 定位/备份 APK → 推送到 /system/app → 重启 → 等待连接 → 设备初始化 → 强制停止", icon: "hi:package" },
  { id: "xdzs-debug-chain", title: "调试一键链", description: "设备初始化 → 编译 Debug → 安装 APK → 拉起测试页面", icon: "hi:flash" },
  { id: "xdzs-install-broadcast", title: "安装后拉起测试页面", description: "安装 APK → 等待 5s → 拉起 DebugActivity", icon: "hi:package" },
  { id: "xdzs-package-and-verify-res", title: "资源打包并验证", description: "打包语音项目资源 → push 到设备 backup 目录 → chmod 777 验证", icon: "hi:package" },
];

const AI_TASKS: Item[] = [
  { id: "ai-bug-analyze", title: "分析 bug 卡片", description: "输入 iCafe 卡片链接，加载 icafe-bug-analyzer 技能跑完整七步流水线，产出结构化根因报告", icon: "hi:ai" },
  { id: "ai-card-transfrom", title: "iCafe 卡片流转", description: "输入 iCafe 卡片与操作要求，自动流转到指定流程", icon: "hi:ai" },
  { id: "ai-daily-bug-report", title: "每日 Bug 流转报告", description: "获取当天由指定操作人流转的 Bug 卡片报告（候选集+流转历史双重确认），按当前真实状态分组输出 JSON", icon: "hi:ai" },
  { id: "demo-ask", title: "问 LLM", description: "输入问题，LLM 流式回答；模型与端点由用户级 auth.json 三键（AI_BASE_URL / AI_AUTH_KEY / AI_MODEL，Settings → Agent 编辑）决定", icon: "hi:ai" },
  { id: "xdzs-verify-fix", title: "验证修复协议测试用例", description: "直填/覆盖 assets/test_case.json → diff_result 验证 → edit_mapping 修复 → 复验归零 → 清理并恢复原文件 → 报告", icon: "hi:test" },
];

/** 动作侧的引用计数近似（脚本正文里的 ${VAR} 不随列表下发）：按真实 actions/ 里「引用该变量的文件数」
 * 写死——log-spm-download→LOGS_DIR；adb-screenshot、xdzs-clean-reinstall→OUTPUT_DIR；
 * xdzs-clean-reinstall、xdzs-debug-chain、xdzs-install-broadcast→VOICE_DEBUG_OUTPUT；
 * xdzs-build-app、xdzs-protocol-query、xdzs-verify-fix→XDZS_SPEECH_DIR。 */
export const STUB_ACTION_REFS: Record<string, number> = {
  LOGS_DIR: 1,
  OUTPUT_DIR: 2,
  VOICE_DEBUG_OUTPUT: 3,
  XDZS_SPEECH_DIR: 3,
};

const withLists = (items: Item[]) =>
  items.map((it) => ({ ...it, params: [], presets: [] }));

export const stubActions = () => withLists(ACTIONS);
export const stubWorkflows = () => withLists(WORKFLOWS);
export const stubAiTasks = () => withLists(AI_TASKS);
