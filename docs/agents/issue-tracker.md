# Issue tracker: GitHub

本仓库事项与规格记录在 GitHub Issues。通过 `git remote -v` 确认仓库，
使用 `gh` CLI 读写；当前远端为 `czj-dev/workflow-tool`。

## Conventions

- 创建：`gh issue create --title "..." --body "..."`。
- 阅读：`gh issue view <number> --comments`；需要标签时一并获取。
- 列表：`gh issue list --state open --json number,title,body,labels,comments`，按需筛选状态或标签。
- 评论：`gh issue comment <number> --body "..."`。
- 标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`。
- 关闭：`gh issue close <number> --comment "..."`。
- 技能要求发布事项时创建 GitHub issue；要求获取事项时用 `gh issue view <number> --comments`。

## Pull requests as a triage surface

**PRs as a request surface: no.** 如需把外部 PR 纳入分流，可改为 `yes`。
GitHub 的 issue 与 PR 共用编号；引用 `#<number>` 时先确认其类型。

## Wayfinding operations

若使用 `/wayfinder`：map 为标记 `wayfinder:map` 的单个 issue；子事项优先用
GitHub sub-issues，不能使用时在 map 中列任务并在子事项正文写 `Part of #<map>`。
阻塞关系优先用 GitHub 原生 issue dependencies，不能使用时在正文写
`Blocked by: #<number>`；领取时通过 `gh issue edit <number> --add-assignee @me`。
