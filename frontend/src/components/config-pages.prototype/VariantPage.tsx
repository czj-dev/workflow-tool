// PROTOTYPE（一次性）：按 ?variant= 决定渲染哪套变体。
// 三套同时挂载、只显示当前那套（其余 display:none）：切变体零闪烁（不用等 lazy chunk），
// 且各变体的折叠 / 筛选 / 展开状态在来回比较时都留着。variant 清空（现行版）→ 整体回落正式页面。
// 外层用 display:contents（而不是再包一层 flex 容器）：变体自己的 <main> 必须仍是 SidebarInset 的直接伸缩项。
// 当前变体排在 DOM 最前：抽屉的 initialFocus 用 document.querySelector 找第一个搜索框，得让它找到可见的那一个。
import { Suspense, lazy } from "react";
import type { ProtoPageProps } from "./slot";
import { useProtoState, type VariantKey } from "./url-state";

const VARIANTS_BY_KEY = {
  A: lazy(() => import("./VariantA")),
  B: lazy(() => import("./VariantB")),
  C: lazy(() => import("./VariantC")),
} satisfies Record<VariantKey, unknown>;
const KEYS = Object.keys(VARIANTS_BY_KEY) as VariantKey[];
const ordered = (active: VariantKey): VariantKey[] =>
  [...KEYS].sort((a, b) => (a === active ? -1 : b === active ? 1 : 0));

export default function ActivePage({ id, inSheet = false, fallback }: ProtoPageProps) {
  const { variant } = useProtoState();
  if (variant === null) return fallback;
  return (
    <>
      {ordered(variant).map((key) => {
        const Page = VARIANTS_BY_KEY[key];
        return (
          <div key={key} className={key === variant ? "contents" : "hidden"}>
            <Suspense fallback={null}>
              <Page page={id} inSheet={inSheet} />
            </Suspense>
          </div>
        );
      })}
    </>
  );
}
