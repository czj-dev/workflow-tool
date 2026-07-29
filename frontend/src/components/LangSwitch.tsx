import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

// 中/EN 语言切换：切换后写入 localStorage 记忆
export function LangSwitch() {
  const { i18n } = useTranslation();
  const next = i18n.language?.startsWith("zh") ? "en" : "zh";
  const label = i18n.language?.startsWith("zh") ? "EN" : "中";
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        i18n.changeLanguage(next);
        localStorage.setItem("lang", next);
      }}
    >
      {label}
    </Button>
  );
}
