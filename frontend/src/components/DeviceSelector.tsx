import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon, SmartPhone02Icon } from "@hugeicons/core-free-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useSidebar } from "@/components/ui/sidebar";
import {
  ListDevices,
  SetActiveDevice,
} from "../../bindings/workflow-tool/internal/api/service.js";
import type { DeviceListResult } from "../../bindings/workflow-tool/internal/api/models.js";
import type { Summary } from "../../bindings/workflow-tool/internal/adb/device/models.js";

// 全局设备选择器：挂在侧栏顶部。激活设备由后端注入为 ${ADB_SERIAL}，
// 所有 adb action（与引用 ${ADB_SERIAL} 的 shell action）共用同一来源。
// 自包含：直接调 bindings，本地维护 devices/active；后端是激活 serial 的唯一真相。
function dotColor(state: string): string {
  switch (state) {
    case "device":
      return "text-emerald-500";
    case "offline":
    case "unauthorized":
      return "text-amber-500";
    case "fastboot":
      return "text-sky-500";
    default:
      return "text-muted-foreground";
  }
}

function deviceLabel(d: Summary): string {
  const name = d.model || d.product || d.serial;
  return name && name !== d.serial ? `${name} (${d.serial})` : d.serial;
}

export function DeviceSelector() {
  const { t } = useTranslation();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const [devices, setDevices] = useState<Summary[]>([]);
  const [active, setActive] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    // 绑定可能被测试 mock 省略，做存在性保护。
    if (typeof ListDevices !== "function") return;
    setLoading(true);
    Promise.resolve(ListDevices())
      .then((res: DeviceListResult | undefined) => {
        setDevices((res && res.devices) || []);
        setActive((res && res.active) || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSelect = (serial: string) => {
    if (!serial) return;
    setActive(serial);
    if (typeof SetActiveDevice === "function") {
      Promise.resolve(SetActiveDevice(serial)).catch(() => refresh());
    }
  };

  const activeDevice = devices.find((d) => d.serial === active);
  const triggerLabel = activeDevice
    ? deviceLabel(activeDevice)
    : devices.length
      ? t("device.select")
      : t("device.empty");

  // 收缩态：侧栏只有图标宽度，完整 select+刷新会溢出。改为单个手机图标 +
  // 状态点角标，点击展开侧栏；tooltip 走 title 显示当前设备。
  if (collapsed) {
    return (
      <div className="flex justify-center px-1 py-1.5">
        <button
          type="button"
          onClick={toggleSidebar}
          title={activeDevice ? deviceLabel(activeDevice) : triggerLabel}
          aria-label={activeDevice ? deviceLabel(activeDevice) : triggerLabel}
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <HugeiconsIcon icon={SmartPhone02Icon} strokeWidth={1.75} className="size-4" />
          <span
            className={`absolute right-1 top-1 size-1.5 rounded-full bg-current ${
              activeDevice ? dotColor(activeDevice.state) : "text-muted-foreground/40"
            }`}
          />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <Select value={active} onValueChange={(v) => onSelect(String(v ?? ""))}>
        <SelectTrigger className="h-8 min-w-0 flex-1" size="sm">
          <span className="flex min-w-0 items-center gap-1.5">
            <HugeiconsIcon
              icon={SmartPhone02Icon}
              strokeWidth={1.75}
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="truncate text-xs">{triggerLabel}</span>
            {activeDevice && (
              <span
                className={`size-1.5 shrink-0 rounded-full bg-current ${dotColor(
                  activeDevice.state,
                )}`}
              />
            )}
          </span>
        </SelectTrigger>
        <SelectContent>
          {devices.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("device.empty")}
            </div>
          )}
          {devices.map((d) => (
            <SelectItem key={d.serial} value={d.serial}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`size-1.5 shrink-0 rounded-full bg-current ${dotColor(
                    d.state,
                  )}`}
                />
                <span className="truncate">{deviceLabel(d)}</span>
                <span className="text-[10px] uppercase text-muted-foreground">
                  {d.mode || ""}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        onClick={refresh}
        title={t("device.refresh")}
        aria-label={t("device.refresh")}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <HugeiconsIcon
          icon={Refresh01Icon}
          strokeWidth={1.75}
          className={`size-4 ${loading ? "animate-spin" : ""}`}
        />
      </button>
    </div>
  );
}
