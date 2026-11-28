// PROTOTYPE（一次性）：正式代码里唯一的两个「插槽」。正式组件只在三处各插一行（main.tsx /
// OutputPanel.tsx / FragmentsSheet.tsx），原型本体全部留在本目录，定稿即整目录删除。
//
// 默认路径零开销：两个判定都不订阅、不 hook——
//   ProtoPage：非 dev 或非原型会话 → 同步返回 fallback（正式页面原样渲染，测试与生产行为不变）；
//   ProtoHost：同上 → null。
// 原型会话里才走 lazy chunk：VariantPage 自己订阅 URL 状态，variant 清空（现行版）时回落 fallback。
import { Suspense, lazy, type ReactElement } from "react";
import { isProtoSession } from "./session";
import type { ProtoPageId } from "./url-state";

const Host = import.meta.env.DEV ? lazy(() => import("./host")) : null;
const ActivePage = import.meta.env.DEV ? lazy(() => import("./VariantPage")) : null;

/** 切换条宿主：挂在 OutputPanel，随原型会话出现（切回「现行版」也保留，便于来回对照）。 */
export function ProtoHost() {
  if (!Host || !isProtoSession()) return null;
  return (
    <Suspense fallback={null}>
      <Host />
    </Suspense>
  );
}

export interface ProtoPageProps {
  id: ProtoPageId;
  /** true = 渲染在 ⌘K 抽屉里（无页头，占满抽屉）；false = 全页视图（带 SidebarTrigger 页头） */
  inSheet?: boolean;
  /** 正式页面。传元素而非组件：原型关闭时不该多一层挂载 */
  fallback: ReactElement;
}

/** 页面插槽：原型开启时渲染当前变体，否则（同步、无 hook）渲染 fallback。 */
export function ProtoPage({ id, inSheet = false, fallback }: ProtoPageProps): ReactElement {
  if (!ActivePage || !isProtoSession()) return fallback;
  return (
    <Suspense fallback={null}>
      <ActivePage id={id} inSheet={inSheet} fallback={fallback} />
    </Suspense>
  );
}
