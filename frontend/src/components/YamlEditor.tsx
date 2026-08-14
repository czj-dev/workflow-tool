import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror from "@uiw/react-codemirror";
import {
  EditorView,
  type ViewUpdate,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import {
  highlightSelectionMatches,
  searchKeymap,
} from "@codemirror/search";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { parseAllDocuments } from "yaml";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconButton } from "./IconButton";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useResolvedTheme } from "./theme-provider";
import {
  useYamlEditorState,
  type YamlEditorItem,
} from "../hooks/useYamlEditorState";

// —— 行内诊断：前端实时 YAML 解析，把首条错误定位到对应行（带列偏移）。
// 不阻断保存（后端为最终真相），仅作可视化提示 + 状态栏汇总。
function lintYaml(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  if (text.trim() === "") return [];
  const doc = view.state.doc;
  const docs = parseAllDocuments(text);
  const diags: Diagnostic[] = [];
  for (const d of docs) {
    for (const err of d.errors) {
      const lp = (err as { linePos?: { line: number; col: number }[] }).linePos?.[0];
      let from = 0;
      let to = 0;
      if (lp) {
        const lineNo = Math.min(Math.max(lp.line, 1), doc.lines);
        const line = doc.line(lineNo);
        const col = Math.min(Math.max((lp.col ?? 1) - 1, 0), line.length);
        from = line.from + col;
        to = Math.min(from + 1, doc.length);
      }
      diags.push({ from, to, severity: "error", message: err.message });
    }
  }
  return diags;
}

// —— 编辑器「外壳」主题：读项目 oklch 设计 token，背景透明贴合卡片，gutter/选中/光标/查找高亮
// 全部跟随主题变量。随 .dark/.light 类自动切换，故对深浅两套高亮都生效。
const chromeTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-content": { caretColor: "var(--primary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection, .cm-line ::selection":
    {
      backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
    },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--foreground) 5%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
    color: "var(--primary)",
    border: "none",
    borderRadius: "4px",
    padding: "0 4px",
  },
  ".cm-panels": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--primary) 30%, transparent)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--primary)",
    color: "var(--primary-foreground)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-lint-marker-error": { color: "var(--destructive)" },
});

export interface YamlEditorProps {
  kind: "action" | "workflow";
  items: YamlEditorItem[];
  currentId: string | null;
  getYaml: (id: string) => Promise<string>;
  saveYaml: (id: string, text: string) => Promise<void>;
  onExit: () => void;
}

// Action / Workflow 共用的 YAML 原文编辑器（CodeMirror 6）：语法高亮 + 行号 + 折叠 +
// 当前行/括号高亮 + Tab 缩进 + 查找替换 + Cmd/Ctrl+S 保存 + 实时校验 + 状态栏 +
// 未保存改动保护。两个入口仅在 kind（i18n 文案与空态）与 onExit 目标视图上不同。
export function YamlEditor({
  kind,
  items,
  currentId,
  getYaml,
  saveYaml,
  onExit,
}: YamlEditorProps) {
  const { t } = useTranslation();
  const resolved = useResolvedTheme();

  const titleKey = kind === "action" ? "edit.title" : "edit.wfTitle";
  const placeholderKey = kind === "action" ? "edit.placeholder" : "edit.wfPlaceholder";
  const emptyKey = kind === "action" ? "edit.empty" : "edit.wfEmpty";

  const state = useYamlEditorState({
    items,
    currentId,
    getYaml,
    saveYaml,
    savedNotice: t("edit.runAfterSave"),
  });
  const { save } = state;

  // Cmd/Ctrl+S 保存：在宿主 div 上以捕获阶段监听 keydown，直接调 save()。
  // 这样无需在渲染期闭包内读写 ref（会触发 react-hooks/refs），也无需随 save 变更重建
  // 编辑器扩展集（重建会丢失撤销历史/光标）。state.save 仅在 effect 依赖里，读取安全。
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "s" || e.key === "S")
      ) {
        e.preventDefault();
        void save();
      }
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, [save]);

  // 编辑器光标位置（状态栏 Ln/Col + 总行数）。docChanged/selectionSet 时更新。
  const [cursor, setCursor] = useState({ line: 1, col: 1, lines: 1 });
  const onUpdate = (vu: ViewUpdate) => {
    if (vu.docChanged || vu.selectionSet) {
      const head = vu.state.selection.main.head;
      const lineObj = vu.state.doc.lineAt(head);
      setCursor({
        line: lineObj.number,
        col: head - lineObj.from + 1,
        lines: vu.state.doc.lines,
      });
    }
  };

  // 扩展集仅随解析主题变化（语法高亮深浅切换）；其余扩展稳定。
  const extensions = useMemo(() => {
    const syntax =
      resolved === "dark"
        ? [oneDark]
        : [syntaxHighlighting(defaultHighlightStyle)];
    return [
      yaml(),
      history(),
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      indentOnInput(),
      closeBrackets(),
      highlightSelectionMatches(),
      lintGutter(),
      linter(lintYaml),
      chromeTheme,
      ...syntax,
      // indentWithTab 走高优先级，保证 Tab 在编辑器内缩进而非移出焦点。
      // Cmd/Ctrl+S 由宿主 div 的 keydown 监听捕获（见 hostRef effect）。
      Prec.highest(keymap.of([indentWithTab])),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
      ]),
    ];
  }, [resolved]);

  const pendingRef = useRef<(() => void) | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const guard = (fn: () => void) => {
    if (state.dirty) {
      pendingRef.current = fn;
      setConfirmOpen(true);
    } else {
      fn();
    }
  };
  const confirmDiscard = () => {
    const fn = pendingRef.current;
    pendingRef.current = null;
    setConfirmOpen(false);
    fn?.();
  };
  const cancelDiscard = () => {
    pendingRef.current = null;
    setConfirmOpen(false);
  };

  if (items.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2">
          <SidebarTrigger />
          <span className="font-semibold">{t(titleKey)}</span>
        </header>
        <div className="p-4 text-muted-foreground">{t(emptyKey)}</div>
      </div>
    );
  }

  return (
    <div ref={hostRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Select
            value={state.editingId ?? undefined}
            onValueChange={(v) => {
              if (v) guard(() => state.setEditingId(v));
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder={t(placeholderKey)} />
            </SelectTrigger>
            <SelectContent>
              {items.map((it) => (
                <SelectItem key={it.id} value={it.id}>
                  {it.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {state.dirty && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-primary">
              <span className="live-pulse size-1.5 rounded-full bg-primary" />
              {t("edit.modified")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            icon={ArrowLeft01Icon}
            label={t("edit.exit")}
            variant="secondary"
            onClick={() => guard(onExit)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!state.dirty || state.saving || state.loading}
            onClick={() => void state.reset()}
          >
            {t("edit.reset")}
          </Button>
          <span className="relative">
            <Button
              size="sm"
              disabled={!state.dirty || state.saving || state.loading}
              onClick={() => void state.save()}
            >
              {state.saving ? t("edit.saving") : t("edit.save")}
            </Button>
            {state.dirty && !state.saving && (
              <span className="live-pulse pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
            )}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          value={state.text}
          onChange={(v) => state.setText(v)}
          extensions={extensions}
          theme="none"
          basicSetup={false}
          editable={!state.loading}
          readOnly={state.loading}
          onUpdate={onUpdate}
          height="100%"
          className="h-full"
          placeholder={t("edit.cmPlaceholder")}
        />
      </div>

      {state.error && (
        <Alert variant="destructive" className="mx-4 my-2">
          <AlertDescription className="whitespace-pre-wrap font-mono text-xs">
            {state.error}
          </AlertDescription>
        </Alert>
      )}

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-1 font-mono text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2 truncate">
          {state.dirty ? (
            <span className="text-primary">{t("edit.modified")}</span>
          ) : state.notice ? (
            <span className="truncate text-success">{state.notice}</span>
          ) : (
            <span>{t("edit.clean")}</span>
          )}
        </div>
        <div className="flex flex-none items-center gap-3 tabular-nums">
          <span className={state.parseError ? "text-destructive" : "text-success"}>
            {state.parseError ? t("edit.invalid") : t("edit.valid")}
          </span>
          <span>
            {t("edit.cursor", { line: cursor.line, col: cursor.col })}
          </span>
          <span>{t("edit.linesCount", { count: cursor.lines })}</span>
        </div>
      </footer>

      <Dialog open={confirmOpen} onOpenChange={(o) => (o ? null : cancelDiscard())}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("edit.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("edit.confirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={cancelDiscard}>
              {t("edit.confirmCancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDiscard}>
              {t("edit.confirmDiscard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
