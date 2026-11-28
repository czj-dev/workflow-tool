import { FragmentsList } from "./FragmentsList";

// ─── 片段全页视图：管理态（大量浏览/CRUD）─────────────────────────────────
// 入口在 Settings「内容管理」；日常快速取用走 FragmentsSheet 抽屉（⌘/Ctrl+K / 侧栏按钮）。
// 列表核心与抽屉共用 FragmentsList（页头含搜索态，随核心走），数据同源 Provider，两处天然同步。
export function FragmentsView() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FragmentsList />
    </div>
  );
}
