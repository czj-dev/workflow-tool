import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSidebar } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";
import { groupLabel, MISC_KEY } from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import { IconButton } from "./IconButton";
import { ParamFields } from "./ParamFields";
import { SavePresetDialog } from "./SavePresetDialog";
import { WorkflowStepsOverview } from "./WorkflowStepsOverview";
import { missingRequired } from "../lib/params";

// 与 ui/sidebar.tsx 的 SIDEBAR_WIDTH / SIDEBAR_WIDTH_ICON 对齐（模块内常量未导出，此处镜像）。
// sheet portal 到 body，继承不到 sidebar-wrapper 上的 --sidebar-width 变量，只能用字面量；
// 侧栏折叠/展开时 left 随 state 切换，配合 transition-all 与侧栏宽度动画同节奏移动。
const SIDEBAR_LEFT = { expanded: "16rem", collapsed: "3rem" } as const;

// ─── 参数表单抽屉：action / workflow 共用的单实例非模态左抽屉 ────────────────
// 形态照搬 FragmentsSheet：modal=false 不锁滚动不挡底下视图、disablePointerDismissal
// 点外部不关（点底下 grid 是正常操作）、Esc 关闭。
// 布局：左缘锚定侧栏右缘；宽度 = 内容区（侧栏右缘→窗口右缘）的 60%，fragments
// 抽屉开着时挤压到与右侧 50vw 的 fragments 拼屏（占满剩余）。见 SheetContent 处 calc。
// 内容按 currentId 解析（workflow 优先、其次 action），开着时点其他项即替换内容。
// 点火即关（Provider 的 runAction / runWorkflow），输出属于主区视图。
export function ParamSheet() {
  const { t } = useTranslation();
  const { state: sidebarState } = useSidebar();
  const {
    actions,
    workflows,
    currentId,
    formSheetOpen,
    setFormSheetOpen,
    fragmentsOpen,
    selectedPreset,
    formValues,
    setFormValue,
    workflowFormValues,
    setWorkflowFormValue,
    runAction,
    runWorkflow,
    selectPreset,
    setView,
  } = useActionRunner();
  const [saveOpen, setSaveOpen] = useState(false);

  // 侧栏右缘位置（expanded / collapsed 字面量）：left 与下方 right 的 calc 共用
  const sidebarLeft =
    sidebarState === "expanded" ? SIDEBAR_LEFT.expanded : SIDEBAR_LEFT.collapsed;

  const workflow = workflows.find((w) => w.id === currentId);
  const action = workflow ? undefined : actions.find((a) => a.id === currentId);
  const item = workflow ?? action;
  const params = workflow?.params ?? action?.params ?? [];
  // 无表单对象 / 无参数：不渲染（入口本就不为无参对象开抽屉，此处防御）
  if (!item || params.length === 0) return null;

  const isWorkflow = !!workflow;
  const values = isWorkflow ? workflowFormValues : formValues;
  const setValue = isWorkflow ? setWorkflowFormValue : setFormValue;

  const canRun = missingRequired(params, values).length === 0;
  const filledCount = params.filter(
    (p) => (values[p.id] ?? p.default ?? "") !== "",
  ).length;

  // 分组名与 Grid 同规则：id 首段前缀，无分隔符归「其它」
  const dash = currentId!.indexOf("-");
  const groupKey = dash > 0 ? currentId!.slice(0, dash) : MISC_KEY;
  const groupText =
    groupKey === MISC_KEY ? t("grid.groupMisc") : groupLabel(groupKey);

  const onRun = () => {
    if (!canRun) return;
    const vals: Record<string, string> = {};
    params.forEach((p) => {
      vals[p.id] = values[p.id] ?? p.default ?? "";
    });
    // FILTER 是保留参数键（不在 yaml params 声明，forEach 覆盖不到）。选中携带
    // FILTER 的 logcat 预设后 formValues 里有它，运行时透传给后端 RuleFromParamsExt。
    if (!isWorkflow && formValues.FILTER) vals.FILTER = formValues.FILTER;
    if (isWorkflow) {
      runWorkflow(item.id, vals);
    } else {
      runAction(item.id, vals);
    }
  };

  const presets = action?.presets ?? [];

  return (
    <Sheet
      open={formSheetOpen}
      modal={false}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        // Esc 归属：内层编辑弹窗（模态 Dialog，如 SavePresetDialog）开着时，同一个 Esc
        // 由它自己消费关闭，抽屉此刻忽略（与 FragmentsSheet 同一仲裁）。两个非模态抽屉
        // 同屏时 base-ui 只关最顶层（escapeKey: isTopmost），一次 Esc 不会连关两层。
        if (
          !open &&
          details?.reason === "escape-key" &&
          document.querySelector('[data-slot="dialog-content"]')
        ) {
          return;
        }
        setFormSheetOpen(open);
      }}
    >
      <SheetContent
        side="left"
        overlay={false}
        showCloseButton={false}
        data-param-sheet=""
        // 打开时把焦点交给首个输入字段，而非头部按钮（与 FragmentsSheet 聚焦搜索框同理）
        initialFocus={() =>
          document.querySelector<HTMLElement>(
            "[data-param-sheet] input, [data-param-sheet] textarea",
          ) ?? true
        }
        // 左缘锚定侧栏右缘、右缘按内容区占比部宽，都用 inline style（压过基类
        // data-[side=left]:left-0，也不受 tailwind 百分比限制）：
        // - 默认：宽度 = 内容区（侧栏右缘→窗口右缘）的 60%，即 right = (100vw−侧栏)×0.4。
        //   不能用 right-3/5：那是视口的 60%，分母含侧栏，会窄一截。
        // - fragments 开着：right = 50vw，与右侧 50vw 的 fragments 拼屏（占满剩余）。
        // 宽度由 left+right 撑开（w-auto 压过基类 w-3/4），transition-all 让挤压/
        // 侧栏折叠与抽屉滑入动画（200ms）同节奏。max-w-none 需要 data-[side=left]:
        // 前缀才会被 tailwind-merge 视作与基类 sm:max-w-sm 同类合并。
        style={{
          left: sidebarLeft,
          right: fragmentsOpen
            ? "50vw"
            : `calc((100vw - ${sidebarLeft}) * 0.4)`,
        }}
        className="gap-0 transition-all data-[side=left]:w-auto data-[side=left]:sm:max-w-none"
      >
        {/* 头部：icon 标题（点击进 yaml 编辑）+ eyebrow 读数 + 关闭。与 FragmentsSheet 头部同构 */}
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-4 py-2.5">
          <SheetTitle className="min-w-0 flex-1 font-mono text-sm font-semibold">
            <button
              type="button"
              title={t("edit.tooltip")}
              onClick={() => setView(isWorkflow ? "workflow-edit" : "edit")}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 font-semibold hover:bg-accent"
            >
              <ActionIcon
                name={item.icon || (isWorkflow ? "hi:workflow" : "hi:play")}
              />
              <span className="truncate">{item.title}</span>
            </button>
          </SheetTitle>
          <span className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
            {groupText} · {currentId} ·{" "}
            {t("grid.paramsCount", { count: params.length })}
          </span>
          <IconButton
            icon={Cancel01Icon}
            label={t("fragments.close")}
            className="text-muted-foreground/60 hover:text-foreground"
            onClick={() => setFormSheetOpen(false)}
          />
        </SheetHeader>

        {/* 滚动容器 + 内容列（max-w-3xl 约束行宽）；运行杆是抽屉固定底条，不在这里 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col px-6 pt-4 pb-6">
            {item.description && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            )}
            {isWorkflow && <WorkflowStepsOverview steps={workflow!.steps ?? []} />}
            {/* 预设条：单击把整套值填入表单（停在表单）；双击直接运行（与侧边栏预设子项一致） */}
            {!isWorkflow && presets.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                  {t("form.presetsLabel")}
                </span>
                {presets.map((p) => (
                  <Badge
                    key={p.name}
                    variant="outline"
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedPreset === p.name || undefined}
                    title={p.name}
                    onClick={() => selectPreset(item.id, p.name)}
                    onDoubleClick={() => runAction(item.id, p.values)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectPreset(item.id, p.name);
                      }
                    }}
                    className={`cursor-pointer bg-muted/60 font-mono text-[11px] tracking-[0.02em]
                      hover:border-primary/60 hover:bg-primary/8 ${
                        selectedPreset === p.name
                          ? "border-primary/60 bg-primary/10 text-primary"
                          : ""
                      }`}
                  >
                    {p.name}
                  </Badge>
                ))}
              </div>
            )}
            <FieldGroup className="mt-5">
              <ParamFields params={params} values={values} setValue={setValue} />
            </FieldGroup>
          </div>
        </div>
        {/* 运行杆：抽屉固有条（不随内容滚动），通宽 border-t、底色继承抽屉 bg-popover，
        与内容零色差；内层 max-w-3xl px-6 与上方字段列对齐。就绪读数 + 击发 */}
        <footer className="flex shrink-0 border-t">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-6 py-3">
            <span
              className={`font-mono text-[11px] font-semibold uppercase tracking-[0.16em] tabular-nums ${
                canRun ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {canRun
                ? t("form.ready")
                : t("form.armedCount", {
                    filled: filledCount,
                    total: params.length,
                  })}
            </span>
            <div className="flex items-center gap-2">
              {!isWorkflow && (
                <Button variant="outline" onClick={() => setSaveOpen(true)}>
                  {t("main.save")}
                </Button>
              )}
              <Button disabled={!canRun} onClick={onRun}>
                <HugeiconsIcon
                  icon={PlayIcon}
                  strokeWidth={1.75}
                  className="size-4"
                />
                {t("main.run")}
              </Button>
            </div>
          </div>
        </footer>
        {!isWorkflow && (
          <SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
        )}
      </SheetContent>
    </Sheet>
  );
}
