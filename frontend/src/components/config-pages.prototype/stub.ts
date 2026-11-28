// PROTOTYPE（一次性）：把 Wails 运行时的 transport 换成内存实现。原型页因此跑在「真实数据的
// 形状与体量」上（见 stub-data），但不读磁盘、不写文件、不执行任何运行。
// 协议：绑定调用 = objectID 0 / method 0，args = { "call-id", methodID, args }，transport 的
// promise 直接 resolve 成方法返回值（无信封）；objectID 10 = 取消调用（原型无在途运行，忽略）。
// 引用计数是近似值：动作侧按真实脚本抄录（STUB_ACTION_REFS，按「引用它的文件数」近似
// 「引用字段数」），再叠加 config 值内联引用与片段引用，并随保存实时重算。
import { setTransport, type RuntimeTransport } from "@wailsio/runtime";
import { extractVars } from "@/lib/vars";
import {
  STUB_ACTION_REFS,
  STUB_CONFIG,
  STUB_FRAGMENTS,
  stubActions,
  stubAiTasks,
  stubWorkflows,
} from "./stub-data";
import { markProtoSession } from "./session";
import { ensureProtoStyles } from "./styles";

const OID_CALL = 0;
const OID_EVENTS = 3;
const OID_CANCEL = 10;

const MID = {
  Cancel: 0,
  ListActions: 1369327256,
  ListAiTasks: 1283763859,
  GetGlobalConfig: 1643579170,
  SetGlobalConfig: 214475134,
  GetFragments: 2047827108,
  SetFragments: 3121140872,
  GetVarReferenceCounts: 2136043017,
  ListWorkflows: 3212907149,
  ListSchedules: 4120213921,
  ListDevices: 3215081228,
  GetAgentConfig: 2977503106,
  ListRuns: 4188708943,
  GetRun: 1975433144,
  GetRunEvents: 3708524649,
  PickDirectory: 3750619027,
  PickFile: 162016838,
  OpenActionsDir: 359800631,
  GetActionYaml: 3805463902,
  GetWorkflowYaml: 1267970661,
  GetAiYaml: 480831730,
} as const;

/** 一律拒绝：原型会话里不该发生任何有副作用的运行 / 改写 */
const REJECT = new Set<number>([
  3925238512, // RunAction
  2350263683, // RunWorkflow
  1869789456, // RunAi
  2746350817, // CancelAction
  1635641018, // CancelWorkflow
  538592525, // CancelAi
  1093800691, // ResumeRun
  605961569, // RunScheduleNow
  3996507181, // SaveSchedule
  2936035959, // DeleteSchedule
  1532781855, // SetScheduleEnabled
  1088793020, // UpdateLogcatFilter
  2530763475, // SetActiveDevice
  1343234505, // ResolveTreeClick
  2256878606, // ResolveTreeClickMulti
  414226499, // AddPreset
  1581553825, // AddAiPreset
  1893008178, // SetActionYaml
  171582705, // SetWorkflowYaml
  4264689902, // SetAiYaml
]);

const REJECT_MSG = "[原型桩] 不执行真实运行";

interface StubState {
  config: Record<string, string>;
  fragments: { title: string; content: string; tags?: string[] }[];
}

const cloneFrags = (list: StubState["fragments"]) =>
  list.map((f) => ({ ...f, tags: f.tags ? [...f.tags] : undefined }));

/** config 值内联引用 + 片段引用 + 动作侧近似：键 = 变量名，值 = 引用处数 */
function refCountsOf(state: StubState): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (name: string, n = 1) => {
    counts[name] = (counts[name] ?? 0) + n;
  };
  for (const [key, value] of Object.entries(state.config)) {
    for (const name of extractVars(value)) if (name !== key) bump(name);
  }
  state.fragments.forEach((f) => extractVars(f.content).forEach((name) => bump(name)));
  for (const [name, n] of Object.entries(STUB_ACTION_REFS)) bump(name, n);
  return counts;
}

export function installStub() {
  const state: StubState = {
    config: { ...STUB_CONFIG },
    fragments: cloneFrags(STUB_FRAGMENTS),
  };
  const warned = new Set<number>();

  const transport: RuntimeTransport = {
    async call(objectID, method, _windowName, args) {
      if (objectID === OID_CANCEL) return null;
      // Events.Emit：本地监听器已在 Events.Emit 内部派发，后端回环在桩里不存在
      if (objectID === OID_EVENTS) return null;
      if (objectID !== OID_CALL || method !== MID.Cancel) return null;

      const id: number = args?.methodID;
      const a: unknown[] = Array.isArray(args?.args) ? (args.args as unknown[]) : [];
      if (REJECT.has(id)) throw new Error(REJECT_MSG);

      switch (id) {
        case MID.ListActions:
          return { actions: stubActions(), errors: [] };
        case MID.ListWorkflows:
          return { workflows: stubWorkflows(), errors: [] };
        case MID.ListAiTasks:
          return { tasks: stubAiTasks(), errors: [] };
        case MID.ListSchedules:
          return { schedules: [], errors: [] };
        case MID.ListDevices:
          return { devices: [], active: "" };
        case MID.ListRuns:
          return { runs: [] };
        case MID.GetRun:
          return null;
        case MID.GetRunEvents:
          return [];
        case MID.GetAgentConfig:
          return { baseUrl: "", authKey: "", model: "" };
        case MID.GetGlobalConfig:
          return { ...state.config };
        case MID.SetGlobalConfig:
          state.config = { ...(a[0] as Record<string, string>) };
          return null;
        case MID.GetFragments:
          return cloneFrags(state.fragments);
        case MID.SetFragments:
          state.fragments = cloneFrags(a[0] as StubState["fragments"]);
          return null;
        case MID.GetVarReferenceCounts:
          return refCountsOf(state);
        case MID.PickDirectory:
        case MID.PickFile:
          return "";
        case MID.OpenActionsDir:
          return null;
        case MID.GetActionYaml:
        case MID.GetWorkflowYaml:
        case MID.GetAiYaml:
          return "";
        default:
          if (!warned.has(id)) {
            warned.add(id);
            console.warn(`[原型桩] 未实现的绑定 methodID=${id}，返回 null`);
          }
          return null;
      }
    },
  };

  ensureProtoStyles();
  setTransport(transport);
  markProtoSession();
}
