# Workflow Tool

把 Workflow、Action、LLM Action 编排为可运行卡片的工作台。本上下文界定其界面与领域语言。

## Language

### 卡形态

**双态卡 (Dual-State Card)**:
Workflow、Action、LLM Action 三类网格卡共用的交互模式：一张卡只有紧凑与展开两种状态。
_Avoid_: 媒体卡、网格卡、大卡小卡

**紧凑态 (Compact State)**:
双态卡的默认状态，只承载身份：状态轨、图标、标题与一行描述。
_Avoid_: 折叠态、收起态

**展开态 (Expanded State)**:
双态卡的二级状态，承载意图：标题区、叙述区、功能行。
_Avoid_: 详情态、放大态

**叙述区 (Narrative Zone)**:
展开态中的弹性文本区；Workflow 卡放描述，LLM 卡放最近会话摘要，运行输出流的接入是其演进位。
_Avoid_: 歌词区、摘要区、描述区

**功能行 (Functional Row)**:
展开态底部的动作行：预设 chips、编辑表单、编辑配置与单一主控。
_Avoid_: 工具栏、操作区

**单一主控 (Single Primary Action)**:
功能行右下角的唯一主按钮，Workflow/Action 是 RUN，LLM 卡是对话。
_Avoid_: 主按钮、运行按钮（泛称）

**编辑配置 (Edit Config)**:
功能行的 ghost 按钮，直达该卡对象的 YAML 编辑页（action → edit，workflow → workflow-edit）。
_Avoid_: 源码编辑、高级编辑

### 交互

**渐进披露 (Progressive Disclosure)**:
双态卡的信息分层原则：紧凑=身份 → 预设环=快选 → 展开=意图。

**hub**:
有预设的卡其紧凑态卡头图标所承担的语义；长按后形变为预设环的环心。
_Avoid_: 环心、卡头按钮、锚点图标

**预设环 (Preset Ring)**:
长按 hub 展开的折扇形预设选择环，是预设的快选路径。
_Avoid_: 折扇环、扇形菜单、径向菜单

**盖盘 (Ring Cover)**:
预设环展开后盖住环内孔的实心圆盘，即形变后的 hub 本体，与卡面氛围色同源。
_Avoid_: 中心盘、圆盘

### 状态与色彩

**StatusRail**:
紧凑态左缘的竖向状态轨，承载状态点、运行足迹与评分。
_Avoid_: 侧栏、状态列

**氛围色 (Ambient Color)**:
双态卡的卡片氛围基色：YAML 可选 `color` 字段（四色板白名单）逐卡优先，未写按分组显示序循环（组内同色、相邻组异色），驱动卡面染色梯度、图标底色与边框；恒为卡色，运行中仅边框与流光让位于 primary。全部 color-mix 插值空间用 `in oklab`（oklch 混 transparent/中性色会 hue 红移，见 ADR-0003）。
_Avoid_: 主题色、环境色、品牌色
