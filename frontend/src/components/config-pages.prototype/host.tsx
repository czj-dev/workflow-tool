// PROTOTYPE（一次性）：原型宿主。只在原型会话里由 OutputPanel 的 <ProtoHost /> 挂载。
// 职责：① 把 URL 的 view / theme 套到应用上 ② 反过来，应用里切到「全局配置 / 指令片段」时同步回 URL
//      ③ 挂切换条。去别的页面时不动 URL——原型状态留着，回来（或用切换条）还能接上。
import { useEffect } from "react";
import { useActionRunner } from "../../hooks/useActionRunner";
import { useTheme } from "../theme-provider";
import { setProtoState, useProtoState, type ProtoPageId } from "./url-state";
import { PrototypeSwitcher } from "./switcher";

const toView = (p: ProtoPageId) => (p === "fragments" ? "fragments" : "global");
const isProtoView = (v: string) => v === "global" || v === "fragments";

export default function ProtoHost() {
  const { page, theme } = useProtoState();
  const { view, setView } = useActionRunner();
  const { setTheme } = useTheme();

  // URL → 应用：进入原型（含直接改地址栏 / 后退前进）时定位到对应页面；主题参数只在这时套一次
  useEffect(() => {
    setView(toView(page));
    if (theme) setTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // 应用 → URL：侧栏「配置」段 / ⌘K 等入口在两页之间切换时跟上；别的视图不碰 URL
  useEffect(() => {
    if (isProtoView(view) && view !== page) setProtoState({ page: view });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return (
    <PrototypeSwitcher
      page={page}
      // 两个动作都做：URL 没变（点的是当前页那一段）时 effect 不会跑，得自己把视图叫回来
      onPage={(p) => {
        setView(toView(p));
        setProtoState({ page: p });
      }}
    />
  );
}
