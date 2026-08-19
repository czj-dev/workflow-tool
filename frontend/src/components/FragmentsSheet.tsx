import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "./IconButton";
import { useActionRunner } from "../hooks/useActionRunner";
import { FragmentsList } from "./FragmentsList";

// ─── 非模态片段抽屉：与任意视图同屏共存 ────────────────────────────────────
// modal=false：不锁滚动、不挡底下视图的交互（跑着 action 同时翻片段的诉求）；
// disablePointerDismissal：点抽屉外不关闭（点击底层视图是正常操作，不是「关闭」意图），
// Esc 仍可关（base-ui 键盘 dismissal 与指针 dismissal 是两条路径）。
// 开合态在 Provider（fragmentsOpen），⌘/Ctrl+K 热键与侧栏按钮共用 toggle。
export function FragmentsSheet() {
  const { t } = useTranslation();
  const { fragmentsOpen, setFragmentsOpen } = useActionRunner();

  return (
    <Sheet
      open={fragmentsOpen}
      modal={false}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        // Esc 归属：内层编辑弹窗（模态 Dialog）开着时，同一个 Esc 由它自己
        // 消费关闭，抽屉此刻忽略，避免一次 Esc 连关两层。
        if (
          !open &&
          details?.reason === "escape-key" &&
          document.querySelector('[data-slot="dialog-content"]')
        ) {
          return;
        }
        setFragmentsOpen(open);
      }}
    >
      <SheetContent
        overlay={false}
        showCloseButton={false}
        // 打开时把焦点交给搜索框，而非默认落在头部关闭按钮上（那样会立刻弹出
        // 它的 tooltip，视觉上很突兀）。data-slot 选择器精确定位到抽屉内搜索输入框。
        initialFocus={() =>
          document.querySelector<HTMLElement>(
            '[data-slot="sheet-content"] input[data-slot="input-group-control"]',
          ) ?? true
        }
        // 占窗口 60%：长命令预览与变量填写要横向空间。
        // 必须带 data-[side=right]: 前缀——Sheet 基础类的 max-w-sm 也带该变体，
        // 特异性 0,2,0 高于裸类，不加前缀会被压回 384px（tailwind-merge 视作不同 key，不合并）。
        className="gap-0 data-[side=right]:w-[60vw] data-[side=right]:sm:max-w-[60vw]"
      >
        <SheetHeader className="flex-row items-center justify-between border-b px-4 py-2.5">
          <SheetTitle className="text-sm font-semibold">
            {t("fragments.title")}
          </SheetTitle>
          <span
            className="font-mono text-[10px] text-muted-foreground/60"
            aria-hidden
          >
            ⌘/Ctrl+K
          </span>
          <IconButton
            icon={Cancel01Icon}
            label={t("fragments.close")}
            className="text-muted-foreground/60 hover:text-foreground"
            onClick={() => setFragmentsOpen(false)}
          />
        </SheetHeader>
        <FragmentsList />
      </SheetContent>
    </Sheet>
  );
}
