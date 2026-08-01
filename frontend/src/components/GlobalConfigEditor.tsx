import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldGroup } from "@/components/ui/field";
import { useActionRunner } from "../hooks/useActionRunner";

// 全局配置编辑：key-value 表格，增删改 + 保存写回 config.yaml
export function GlobalConfigEditor() {
  const { t } = useTranslation();
  const { globalConfig, saveGlobalConfig } = useActionRunner();
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(globalConfig).map(([key, value]) => ({ key, value }))
  );
  const [dirty, setDirty] = useState(false);

  // globalConfig（异步）加载后同步 rows：用 render-time 调整代替 effect 内 setState，避免级联渲染。
  // 未编辑时才同步，避免覆盖用户改动。
  const [prevConfig, setPrevConfig] = useState(globalConfig);
  if (globalConfig !== prevConfig) {
    setPrevConfig(globalConfig);
    if (!dirty) {
      setRows(Object.entries(globalConfig).map(([key, value]) => ({ key, value })));
    }
  }

  const update = (i: number, field: "key" | "value", v: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
    setDirty(true);
  };
  const add = () => {
    setRows((prev) => [...prev, { key: "", value: "" }]);
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const save = async () => {
    const kv: Record<string, string> = {};
    rows.forEach((r) => {
      if (r.key.trim()) kv[r.key.trim()] = r.value;
    });
    await saveGlobalConfig(kv);
    setDirty(false);
  };

  return (
    <FieldGroup className="p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t("global.title")}</h2>
        <Button size="sm" onClick={add}>
          {t("global.add")}
        </Button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input
            value={r.key}
            onChange={(e) => update(i, "key", e.target.value)}
            placeholder="KEY"
          />
          <Input
            value={r.value}
            onChange={(e) => update(i, "value", e.target.value)}
            placeholder="value"
          />
          <Button variant="outline" size="sm" onClick={() => remove(i)}>
            {t("global.remove")}
          </Button>
        </div>
      ))}
      <Button disabled={!dirty} onClick={save}>
        {t("global.save")}
      </Button>
    </FieldGroup>
  );
}
