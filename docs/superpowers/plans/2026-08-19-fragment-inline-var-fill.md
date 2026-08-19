# Fragments 缺失变量就地填写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 FragmentsView 的片段预览里，点击缺失变量（红框 pill）就地变成输入框，填入的值只在当前会话生效，参与复制时的 `${VAR}` 展开。

**Architecture:** 单文件改动。`FragmentsView` 组件内新增会话态 `overrides`（fragment 索引 → 变量名 → 临时值），`ContentPreview` 新增第三种 pill 状态（可编辑），复制/缺失变量提示统一从 `{ ...globalConfig, ...overrides[i] }` 读值。

**Tech Stack:** React 19 + TypeScript + Vitest + Testing Library（复用现有依赖，不新增任何包）。

## Global Constraints

- 不落盘：临时值只存 React state，刷新/切视图即丢失（spec 明确非目标）。
- 已定义的变量（`globalConfig` 中存在）pill 保持只读，不可点击编辑。
- 复制展开逻辑仍需与 `internal/runner.Expand` 保持一致：未命中变量原样保留 `${VAR}`。
- 编辑/新增/删除片段后清空 `overrides`（索引可能错位，简单正确优先于精细保留）。
- 不修改 `lib/vars.ts`、后端、YAML schema、`FragmentDialog.tsx`。
- 代码注释使用中文，与本文件现有注释风格一致。

---

## 文件结构

- **Modify: `frontend/src/components/FragmentsView.tsx`**
  - `ContentPreview`：新增 `overrides` / `onSetVar` props，缺失变量 pill 分裂为「缺失只读」→「缺失可编辑」逻辑
  - 新增组件 `EditableVarPill`（同文件内，就近维护，不单独建文件——组件小且只有这一处用）
  - `FragmentsView` 主体：新增 `overrides` state，`copyOne`/`missing` 计算合并 overrides，`saveOne`/`clickDelete` 清空 overrides
- **Modify: `frontend/src/components/FragmentsView.test.tsx`**
  - 新增一个 `describe("FragmentsView - 缺失变量就地填写")` 块，覆盖 spec 里列的 7 个场景

不新增文件、不动 i18n（现有 `fragments.missingVars` 等 key 已够用，无需新文案）。

---

## Task 1: EditableVarPill 组件 + ContentPreview 接入

**Files:**
- Modify: `frontend/src/components/FragmentsView.tsx`
- Test: `frontend/src/components/FragmentsView.test.tsx`

**Interfaces:**
- Consumes: 现有 `extractVars`/`expandVars`（`@/lib/vars`，不改）
- Produces:
  - `EditableVarPill(props: { name: string; value?: string; onSubmit: (name: string, value: string) => void }): JSX.Element` — 缺失变量的可编辑 pill，`value` 为 undefined 时显示变量名（缺失态），有值时显示该值（已填态）
  - `ContentPreview` 新增 props：`overrides: Record<string, string>`（该 fragment 的临时值表）、`onSetVar: (name: string, value: string) => void`

### Step 1: 写失败的测试 — 点击缺失变量出现输入框

在 `FragmentsView.test.tsx` 末尾追加新 describe 块（放在文件最后一个 `describe` 之后，注意保持文件以 `});` 结尾）：

```tsx
describe("FragmentsView - 缺失变量就地填写", () => {
  it("点击缺失变量 pill 后出现输入框", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    expect(screen.getByRole("textbox", { name: "NOPE" })).toBeInTheDocument();
  });
});
```

### Step 2: 运行测试确认失败

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "点击缺失变量 pill 后出现输入框"`

Expected: FAIL — 此时点击 `NOPE` 文本不会出现任何 `textbox`（当前缺失 pill 是纯 `<span>`，不可点击）。

### Step 3: 实现 EditableVarPill，接入 ContentPreview

打开 `frontend/src/components/FragmentsView.tsx`，找到现有 `ContentPreview` 函数（约第 43-83 行）。在该函数**之前**插入新组件：

```tsx
// EditableVarPill：缺失变量的可点击 pill。未填时显示变量名（红框），
// 点击后原地变 input，Enter/失焦提交，Esc 取消。已填时显示填入的值
// （琥珀 + 虚线下边框，区别于全局定义的实心琥珀），仍可再点重新编辑。
function EditableVarPill({
  name,
  value,
  onSubmit,
}: {
  name: string;
  value?: string;
  onSubmit: (name: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  if (editing) {
    return (
      <input
        aria-label={name}
        autoFocus
        size={Math.max(4, draft.length || name.length)}
        className="mx-px rounded-sm border border-primary/50 bg-background px-1 py-px font-mono text-[11px] outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (draft.trim()) onSubmit(name, draft);
          setEditing(false);
        }}
      />
    );
  }

  const filled = value !== undefined;
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value ?? "");
        setEditing(true);
      }}
      className={cn(
        "mx-px rounded-sm px-1 py-px font-mono text-[11px]",
        filled
          ? "border-b border-dashed border-primary/50 bg-primary/12 text-primary"
          : "border border-destructive/50 text-destructive",
      )}
      title={filled ? name : undefined}
    >
      {filled ? value : name}
    </button>
  );
}
```

现在修改 `ContentPreview` 签名和缺失变量分支。找到：

```tsx
function ContentPreview({
  content,
  vars,
}: {
  content: string;
  vars: Record<string, string>;
}) {
```

替换为：

```tsx
function ContentPreview({
  content,
  vars,
  overrides,
  onSetVar,
}: {
  content: string;
  vars: Record<string, string>;
  overrides: Record<string, string>;
  onSetVar: (name: string, value: string) => void;
}) {
```

找到函数内的 `if (!m) return part;` 之后的逻辑（约第 55-79 行）：

```tsx
        const name = m[1];
        const value = vars[name];
        const defined = value !== undefined;
        const pill = (
          <span
            className={cn(
              "mx-px rounded-sm px-1 py-px font-mono text-[11px]",
              defined
                ? "bg-primary/12 text-primary"
                : "border border-destructive/50 text-destructive",
            )}
          >
            {name}
          </span>
        );
        // 已定义的变量 hover 显示当前值；缺失的靠红框自解释，不必再挂 tooltip
        return defined ? (
          <Tooltip key={i}>
            <TooltipTrigger render={pill} />
            <TooltipContent className="font-mono text-xs">{value}</TooltipContent>
          </Tooltip>
        ) : (
          <span key={i}>{pill}</span>
        );
```

替换为：

```tsx
        const name = m[1];
        const value = vars[name];
        const defined = value !== undefined;
        // 已定义（全局配置）：只读 pill，hover 看值
        if (defined) {
          const pill = (
            <span className="mx-px rounded-sm bg-primary/12 px-1 py-px font-mono text-[11px] text-primary">
              {name}
            </span>
          );
          return (
            <Tooltip key={i}>
              <TooltipTrigger render={pill} />
              <TooltipContent className="font-mono text-xs">{value}</TooltipContent>
            </Tooltip>
          );
        }
        // 未定义：可点击就地填写，临时值只在本会话生效
        return (
          <EditableVarPill
            key={i}
            name={name}
            value={overrides[name]}
            onSubmit={onSetVar}
          />
        );
```

现在更新 `FragmentsView` 主体里所有 `<ContentPreview ... />` 的调用点。找到（约第 286-289 行）：

```tsx
                          <ContentPreview
                            content={f.content}
                            vars={globalConfig}
                          />
```

替换为：

```tsx
                          <ContentPreview
                            content={f.content}
                            vars={globalConfig}
                            overrides={overrides[i] ?? {}}
                            onSetVar={(name, value) => setVarOverride(i, name, value)}
                          />
```

（`overrides` state 和 `setVarOverride` 函数在 Task 2 里定义；此步先接好调用点，Task 2 补齐定义后才能编译通过——两个 task 合并到同一次提交前的编译检查里做，见 Step 4。）

### Step 4: 补齐 state 定义使代码可编译，运行测试确认通过

在 `FragmentsView` 函数内，找到现有 state 声明块（约第 115-120 行）：

```tsx
  const [q, setQ] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  // null=关闭；-1=新增；>=0 编辑该索引
  const [editing, setEditing] = useState<number | null>(null);
```

在其后追加：

```tsx
  // 缺失变量的临时填写值：fragment 索引 → 变量名 → 值。仅内存，不落盘，
  // 编辑/删除片段后索引可能错位，此时整体清空（见 saveOne/clickDelete）。
  const [overrides, setOverrides] = useState<Record<number, Record<string, string>>>({});

  const setVarOverride = (i: number, name: string, value: string) => {
    setOverrides((cur) => ({
      ...cur,
      [i]: { ...(cur[i] ?? {}), [name]: value },
    }));
  };
```

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "点击缺失变量 pill 后出现输入框"`

Expected: PASS

### Step 5: Commit

```bash
git add frontend/src/components/FragmentsView.tsx frontend/src/components/FragmentsView.test.tsx
git commit -m "feat(fragments): 缺失变量支持点击就地填写"
```

---

## Task 2: 提交填写值 → pill 显示已填态

**Files:**
- Modify: `frontend/src/components/FragmentsView.tsx`（Task 1 已完成大部分，本任务验证提交路径）
- Test: `frontend/src/components/FragmentsView.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `EditableVarPill`、`overrides` state、`setVarOverride`
- Produces: 无新接口，验证既有实现的提交行为

### Step 1: 写失败的测试 — Enter 提交后 pill 显示填入的值

追加到 Task 1 的 describe 块内：

```tsx
  it("输入值后 Enter 提交，pill 显示填入的值", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    const input = screen.getByRole("textbox", { name: "NOPE" });
    await user.type(input, "/tmp/foo.apk{Enter}");
    expect(screen.getByText("/tmp/foo.apk")).toBeInTheDocument();
    expect(screen.queryByText("NOPE")).not.toBeInTheDocument();
  });

  it("Esc 取消编辑，pill 复原为变量名", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    const input = screen.getByRole("textbox", { name: "NOPE" });
    await user.type(input, "abc{Escape}");
    expect(screen.getByText("NOPE")).toBeInTheDocument();
    expect(screen.queryByText("abc")).not.toBeInTheDocument();
  });

  it("已定义的琥珀 pill 点击无反应，不出现输入框", async () => {
    renderView();
    await screen.findByText("看日志");
    await user.click(screen.getByText("LOGS_DIR"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
```

注意最后一个测试用了 `user` 但当前 `it` 回调没声明 —— 补全为：

```tsx
  it("已定义的琥珀 pill 点击无反应，不出现输入框", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.click(screen.getByText("LOGS_DIR"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
```

### Step 2: 运行测试确认现状

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "输入值后 Enter 提交"`

Expected: 若 Task 1 的 `EditableVarPill` 实现正确（`onKeyDown` 里 Enter 触发 `blur()`，`onBlur` 里 `onSubmit`），这个测试此刻应该已经 PASS——因为 Task 1 的 Step 3/4 已经实现了完整提交逻辑。这一步是**确认性验证**，不是新实现。

若 FAIL，检查 `EditableVarPill` 的 `onBlur` 处理器是否正确调用了 `onSubmit(name, draft)`。

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "Esc 取消编辑"`

Expected: PASS（`onKeyDown` 的 Escape 分支已在 Task 1 实现）

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "已定义的琥珀 pill 点击无反应"`

Expected: PASS（已定义分支渲染的是 `<span>` 包 `<Tooltip>`，不是 `<button>`，点击无效果）

### Step 3: 若测试全部已通过，跳过实现步骤；否则修复

（正常情况下本任务不需要新代码 —— 它是对 Task 1 实现的行为验证。如果三者都 PASS，直接进入 Step 4。）

### Step 4: 运行完整测试文件确认无回归

Run: `npx vitest run src/components/FragmentsView.test.tsx`

Expected: 全部测试 PASS（包括本文件原有的所有测试）

### Step 5: Commit

```bash
git add frontend/src/components/FragmentsView.test.tsx
git commit -m "test(fragments): 覆盖变量填写提交/取消/只读定义变量场景"
```

---

## Task 3: 复制时合并临时值，缺失提示同步收窄

**Files:**
- Modify: `frontend/src/components/FragmentsView.tsx:164-173`（`copyOne`）、`:270-274`（`missing` 计算）
- Test: `frontend/src/components/FragmentsView.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `overrides` state（`Record<number, Record<string, string>>`）
- Produces: `copyOne(i: number)` 的展开值表包含临时值；`missing` 计算排除已临时填写的变量

### Step 1: 写失败的测试 — 复制内容包含临时填写的值

追加到 describe 块：

```tsx
  it("复制时合并临时填写的值，未填的仍保留 ${VAR}", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE} ${LOGS_DIR}", tags: [] },
    ]);
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "/tmp/foo.apk{Enter}");

    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(mockWriteText).toHaveBeenCalledWith("echo /tmp/foo.apk /tmp/logs");
  });

  it("填写变量后，缺变量提示行消失", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    expect(await screen.findByText(/缺变量.*NOPE/)).toBeInTheDocument();

    await user.click(screen.getByText("NOPE"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "val{Enter}");
    expect(screen.queryByText(/缺变量/)).not.toBeInTheDocument();
  });
```

### Step 2: 运行测试确认失败

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "复制时合并临时填写的值"`

Expected: FAIL — `mockWriteText` 收到的实参仍是 `"echo /tmp/foo.apk ${LOGS_DIR}"` 或类似，因为当前 `copyOne` 只用 `globalConfig` 展开（不含 overrides），而且 `LOGS_DIR` mock 返回值实际是 `/tmp/logs`——先确认具体的失败断言差异在于 `NOPE` 未被替换。

### Step 3: 实现 — copyOne 与 missing 合并 overrides

找到 `copyOne`（约第 164-173 行）：

```tsx
  const copyOne = async (i: number) => {
    await navigator.clipboard.writeText(
      expandVars(fragments[i].content, globalConfig),
    );
    setCopiedIdx(i);
    setTimeout(
      () => setCopiedIdx((cur) => (cur === i ? null : cur)),
      COPIED_FEEDBACK_MS,
    );
  };
```

替换为：

```tsx
  const copyOne = async (i: number) => {
    const vars = { ...globalConfig, ...(overrides[i] ?? {}) };
    await navigator.clipboard.writeText(expandVars(fragments[i].content, vars));
    setCopiedIdx(i);
    setTimeout(
      () => setCopiedIdx((cur) => (cur === i ? null : cur)),
      COPIED_FEEDBACK_MS,
    );
  };
```

找到 `missing` 计算（在列表渲染内，约第 270-274 行）：

```tsx
                  const missing = extractVars(f.content).filter(
                    (v) => !(v in globalConfig),
                  );
```

替换为：

```tsx
                  const fragOverrides = overrides[i] ?? {};
                  const missing = extractVars(f.content).filter(
                    (v) => !(v in globalConfig) && !(v in fragOverrides),
                  );
```

### Step 4: 运行测试确认通过

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "复制时合并临时填写的值"`

Expected: PASS

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "填写变量后，缺变量提示行消失"`

Expected: PASS

### Step 5: Commit

```bash
git add frontend/src/components/FragmentsView.tsx frontend/src/components/FragmentsView.test.tsx
git commit -m "feat(fragments): 复制时合并临时变量值，缺失提示同步收窄"
```

---

## Task 4: 编辑/删除片段后清空 overrides

**Files:**
- Modify: `frontend/src/components/FragmentsView.tsx:176-197`（`clickDelete`、`saveOne`）
- Test: `frontend/src/components/FragmentsView.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `overrides`/`setOverrides`
- Produces: `clickDelete`、`saveOne` 在变更片段列表后清空 `overrides`

### Step 1: 写失败的测试 — 删除片段后 overrides 清空

追加到 describe 块：

```tsx
  it("删除片段后，临时填写的变量值被清空", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
      { title: "y", content: "echo ${ALSO_NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByText("NOPE"));
    await user.type(screen.getByRole("textbox", { name: "NOPE" }), "filled{Enter}");
    expect(screen.getByText("filled")).toBeInTheDocument();

    // 删除第二条片段（y），触发二次确认删除流程
    const delBtns = screen.getAllByRole("button", { name: "删除" });
    await user.click(delBtns[1]);
    await user.click(screen.getByRole("button", { name: "再次点击确认删除" }));

    // x 仍在，但它的临时值应已被清空（索引语义已变，安全起见整体清空）
    expect(await screen.findByText("NOPE")).toBeInTheDocument();
    expect(screen.queryByText("filled")).not.toBeInTheDocument();
  });
```

### Step 2: 运行测试确认失败

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "删除片段后，临时填写的变量值被清空"`

Expected: FAIL — 当前 `clickDelete` 不清空 `overrides`，删除 y 后 x 的 `overrides[0]` 里 `NOPE=filled` 仍保留，`filled` 仍会出现在页面上。

### Step 3: 实现 — clickDelete 与 saveOne 清空 overrides

找到 `clickDelete`（约第 176-187 行）：

```tsx
  // 删除二次确认：首次点击标记 pending，窗口内再点才真删
  const clickDelete = (i: number) => {
    if (pendingDelete !== i) {
      setPendingDelete(i);
      setTimeout(
        () => setPendingDelete((cur) => (cur === i ? null : cur)),
        CONFIRM_WINDOW_MS,
      );
      return;
    }
    setPendingDelete(null);
    void saveFragments(fragments.filter((_, idx) => idx !== i));
  };
```

替换为：

```tsx
  // 删除二次确认：首次点击标记 pending，窗口内再点才真删
  const clickDelete = (i: number) => {
    if (pendingDelete !== i) {
      setPendingDelete(i);
      setTimeout(
        () => setPendingDelete((cur) => (cur === i ? null : cur)),
        CONFIRM_WINDOW_MS,
      );
      return;
    }
    setPendingDelete(null);
    setOverrides({}); // 索引会整体前移，临时值直接清空避免串值
    void saveFragments(fragments.filter((_, idx) => idx !== i));
  };
```

找到 `saveOne`（约第 190-197 行）：

```tsx
  // 单条落盘：editing=-1 追加，否则替换该索引
  const saveOne = (row: FragmentRow) => {
    const list =
      editing === -1
        ? [...fragments, row]
        : fragments.map((f, idx) => (idx === editing ? row : f));
    void saveFragments(list);
    setEditing(null);
  };
```

替换为：

```tsx
  // 单条落盘：editing=-1 追加，否则替换该索引
  const saveOne = (row: FragmentRow) => {
    const list =
      editing === -1
        ? [...fragments, row]
        : fragments.map((f, idx) => (idx === editing ? row : f));
    setOverrides({}); // 内容可能变了，旧的临时变量值不再适用
    void saveFragments(list);
    setEditing(null);
  };
```

### Step 4: 运行测试确认通过

Run: `npx vitest run src/components/FragmentsView.test.tsx -t "删除片段后，临时填写的变量值被清空"`

Expected: PASS

### Step 5: 运行完整测试文件 + typecheck 确认无回归

Run: `npx vitest run src/components/FragmentsView.test.tsx`

Expected: 全部测试 PASS

Run: `npx tsc --noEmit`

Expected: 无类型错误

### Step 6: Commit

```bash
git add frontend/src/components/FragmentsView.tsx frontend/src/components/FragmentsView.test.tsx
git commit -m "fix(fragments): 编辑/删除片段后清空临时变量值，避免索引错位串值"
```

---

## 完成后校验

1. Run: `npx vitest run src/components/FragmentsView.test.tsx` — 全部 PASS（原有 + 新增全部场景）
2. Run: `npx tsc --noEmit` — 无类型错误
3. Run: `npm run lint`（前端目录下）— 无新增 lint 错误
4. 手动验证（可选，需要 `bash deploy/build.sh` 出可运行 exe）：打开 Fragments 视图，找一条带未定义变量的片段，点红框 → 输入 → Enter → 复制 → 粘贴确认内容正确
