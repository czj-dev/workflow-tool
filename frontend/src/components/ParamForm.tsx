import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon, PreferenceHorizontalIcon } from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";
import { groupLabel, MISC_KEY } from "../hooks/useActionUsage";
import { SavePresetDialog } from "./SavePresetDialog";
import { ParamFields } from "./ParamFields";
import { OutputConsole } from "./OutputConsole";
import { missingRequired } from "../lib/params";

// 发射台：动作参数表单的双形态视图。
// 装配态（表单）：eyebrow 读数行 + 预设条 + 字段卡片 + 吸底运行杆。
// 发射态（点火后）：表单收起为「本次装配」参数摘要条，输出在原位展开——
// 改参重跑 = 展开编辑 → 改 → 再点火，一步到位（runAction 的 stayInForm 路径不切视图）。
export function ParamForm() {
  const { t } = useTranslation();
  const {
    actions,
    currentId,
    selectedPreset,
    status,
    isRunning,
    lastRunParams,
    formValues,
    setFormValue,
    runAction,
    selectPreset,
  } = useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const [saveOpen, setSaveOpen] = useState(false);
  // 展开编辑 override：发射态下点「展开编辑」回表单；再点火时复位
  const [editing, setEditing] = useState(false);
  if (!action || !action.params || action.params.length === 0) return null;

  const params = action.params;
  // 发射态：已点火（status 非 idle 且未被展开编辑覆盖）
  const launched = !editing && status !== "idle";

  // ——— 发射态：摘要条 + 输出 ———
  if (launched) {
    const runParams = lastRunParams[action.id] ?? {};
    const entries = Object.entries(runParams);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
            {t("form.launchedLabel")}
          </span>
          {isRunning(action.id) && (
            <span className="size-1.5 rounded-full bg-primary live-pulse" />
          )}
          {entries.length === 0 ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {t("grid.noParams")}
            </span>
          ) : (
            entries.map(([k, v]) => (
              <span
                key={k}
                className="max-w-56 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] tracking-[0.02em]"
                title={`${k}=${v}`}
              >
                <span className="text-foreground/80">{k}</span>
                <span className="text-muted-foreground">={v}</span>
              </span>
            ))
          )}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setEditing(true)}
          >
            <HugeiconsIcon icon={PreferenceHorizontalIcon} strokeWidth={1.75} />
            {t("form.expandEdit")}
          </Button>
        </div>
        <OutputConsole />
      </div>
    );
  }

  // ——— 装配态：表单 ———
  const canRun = missingRequired(params, formValues).length === 0;
  const filledCount = params.filter(
    (p) => (formValues[p.id] ?? p.default ?? "") !== "",
  ).length;

  // 分组名与 Grid 同规则：id 首段前缀，无分隔符归「其它」
  const dash = action.id.indexOf("-");
  const groupKey = dash > 0 ? action.id.slice(0, dash) : MISC_KEY;
  const groupText = groupKey === MISC_KEY ? t("grid.groupMisc") : groupLabel(groupKey);

  const onRun = () => {
    if (!canRun) return;
    const values: Record<string, string> = {};
    params.forEach((p) => {
      values[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    setEditing(false);
    runAction(action.id, values);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-5">
        {/* eyebrow 读数行：分组 · id ── 参数数 */}
        <header>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
              {groupText} · {action.id}
            </span>
            <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground tabular-nums">
              {t("grid.paramsCount", { count: params.length })}
            </span>
          </div>
          {action.description && (
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {action.description}
            </p>
          )}
          {/* 预设条：点击把整套值填入表单（停在表单，不直接运行） */}
          {action.presets && action.presets.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                {t("form.presetsLabel")}
              </span>
              {action.presets.map((p) => (
                <Badge
                  key={p.name}
                  variant="outline"
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedPreset === p.name || undefined}
                  onClick={() => selectPreset(action.id, p.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectPreset(action.id, p.name);
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
        </header>

        {/* 字段区：每个字段是一张输入卡片（ui 层定义质感），完成度由运行杆读数承载 */}
        <FieldGroup className="mt-5 min-h-0 flex-1">
          <ParamFields params={params} values={formValues} setValue={setFormValue} />
        </FieldGroup>

        {/* 运行杆：短表单沉底、长表单吸底，就绪读数 + 击发 */}
        <footer className="sticky bottom-0 mt-6 flex items-center justify-between gap-3 border-t bg-background/95 pt-3 pb-4 backdrop-blur-sm">
          <span
            className={`font-mono text-[11px] font-semibold uppercase tracking-[0.16em] tabular-nums ${
              canRun ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {canRun
              ? t("form.ready")
              : t("form.armedCount", { filled: filledCount, total: params.length })}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setSaveOpen(true)}>
              {t("main.save")}
            </Button>
            <Button disabled={!canRun} onClick={onRun}>
              <HugeiconsIcon icon={PlayIcon} strokeWidth={1.75} className="size-4" />
              {t("main.run")}
            </Button>
          </div>
        </footer>
        <SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
      </div>
    </div>
  );
}
