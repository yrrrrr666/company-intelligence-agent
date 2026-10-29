---
name: 企业情报研究助手
description: 来源与状态清晰对应的本地研究工作台
colors:
  bg: "#f1f5f8"
  surface: "#ffffff"
  surface-subtle: "#f7f9fb"
  ink: "#22333e"
  muted: "#536a79"
  border: "#cbd8e0"
  divider: "#e0e7ed"
  primary: "#173c55"
  primary-hover: "#0e2e44"
  selected: "#eaf2f7"
  scope: "#e5eef4"
  success: "#176f60"
  success-bg: "#eaf4f0"
  warning: "#805216"
  warning-bg: "#fbf3e5"
  danger: "#a13732"
  danger-bg: "#fceeed"
  focus: "#29678e"
typography:
  headline:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.45
  title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.6
  detail:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.7
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.65
  button:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.65
rounded:
  tag: "4px"
  control: "6px"
  panel: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 17px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "#334e60"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 17px"
  button-include:
    backgroundColor: "{colors.success}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 17px"
  button-link:
    backgroundColor: "transparent"
    textColor: "#215d83"
    padding: "7px 8px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  tag:
    backgroundColor: "#edf1f5"
    textColor: "#4c6373"
    rounded: "{rounded.tag}"
    padding: "1px 6px"
  tag-included:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success}"
    rounded: "{rounded.tag}"
    padding: "1px 6px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  step-navigation:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    padding: "16px 5px"
  step-current:
    textColor: "{colors.primary}"
  source-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    padding: "14px 20px"
---

# Design System: 企业情报研究助手

## Overview

**Creative North Star: "来源与状态"**

界面借用资料索引与状态图例的组织方式：深蓝产品栏建立稳定边界，冷白工作区承载内容，浅蓝色块标示范围与当前选择。气质克制、清楚、偏工作台；信息密度服务于连续操作和原文核查。

视觉层级由标题、固定字段、分隔线和文字状态共同建立。按钮直接说明用途；资料编号、来源信息、核查状态在不同视图保持相同语言。用户已明确拒绝上一版的通用 AI 模板感；延续当前以内容和操作为中心的表达。

**Key Characteristics:**
- 深蓝导航与冷白资料面形成稳定的前景、背景关系。
- 紧凑文字、细分隔线与有限色面承担层级。
- 状态颜色始终配有可读文字。
- 系统字体服务于中文操作与长文本核查。
- 内容面保持平面，浮层才使用投影。

## Colors

调色板以冷白、蓝灰和深蓝为主，绿色、琥珀和红色承担明确的状态含义；精确值以上方 tokens 为准，与 `web/styles.css` 的根变量对应。

### Primary
- **资料深蓝**（`primary` / `primary-hover`）：产品栏、主要操作、当前流程与选中筛选的文字或底线。
- **当前选择浅蓝**（`selected`）：资料选中行以及轻量交互反馈。
- **范围浅蓝**（`scope`）：研究范围信息带；比白色资料面更易定位。
- **焦点蓝**（`focus`）：键盘焦点轮廓，不替代选中状态。

### Secondary
- **纳入绿**（`success` / `success-bg`）：纳入操作、已纳入标签和对应统计。
- **核查琥珀**（`warning` / `warning-bg`）：待核实、范围提示和信息缺口。
- **异常红**（`danger` / `danger-bg`）：字段错误、必填提示与没有可用正文的标签。

### Neutral
- **冷灰工作底**（`bg`）：页面背景。
- **资料白**（`surface`）：表单、资料区、报告与对话框。
- **轻灰白**（`surface-subtle`）：辅助内容面及轻量 hover。
- **正文墨蓝**（`ink`）与 **说明蓝灰**（`muted`）：正文和辅助信息。
- **边框灰蓝**（`border`）与 **细分隔灰**（`divider`）：区域边界和内部记录分隔。

**The Labeled Status Rule.** 绿色、琥珀或红色状态必须同时提供文字；颜色不能单独传达是否纳入、待核实或错误。

## Typography

**Body / UI Font:** Segoe UI，中文回退 Microsoft YaHei，最后回退 sans-serif。标题、正文、标签共用这一字体栈；当前没有单独的展示字体或等宽字体体系。

**Character:** 稳定、直接的工具型排印。层级依靠字号、字重、行距和位置，不依赖装饰性英文小标题。

### Hierarchy
- **Headline**：页面主标题；桌面（24px / 650 / 1.45）。
- **Title**：区块标题（17px / 600 / 1.6）；紧凑记录标题使用正文尺度。
- **Detail**：原文详情标题（20px / 600 / 1.7）。
- **Body**：操作与普通正文（14px / 400 / 1.65）。保存文本使用（2）行高、最大（70ch）；简报陈述使用（2.05）行高，文档容器最大（78ch）。
- **Label**：帮助、元数据与状态标签（12px）；说明性正文常用（13px）。数字编号、日期与统计采用等宽数字特性。
- **Button**：普通操作（14px / 500）；表单标签使用（14px / 500）。

**The Reading Measure Rule.** 长篇原文与简报保留各自的行长上限和宽松行距；增加屏幕宽度时不无限拉长文本行。

## Layout

当前仅支持桌面网页，页面最小宽度（1120px）。主要内容、产品栏与流程导航使用最大（1392px）的居中容器，水平内边距（48px）。主工作区与独立示例侧栏的外层最大宽度为（1728px）。重复间距的基础节奏为（4 / 8 / 16 / 24 / 32px），按信息关系保留实测的局部间距。

现有研究工作台的四步导航始终保持四等分横向排列，选中步骤用底线和实心编号圆标识。范围带使用固定字段顺序；“固定展示”指字段在工作流中持续可见，当前实现不使用 sticky 定位。

创建页只显示正式研究表单，表单最大宽度（840px）并与页面标题左对齐。示例体验从顶栏入口展开，默认收起；展开后在主内容之外显示（336px）宽的右侧独立栏，有自己的纵向滚动，关闭按钮位于顶部。它不是模态窗口，保留主界面的可操作性。审核区始终采用来源索引与正文相邻的双栏，列表最大高度（540px）；详情按钮允许折行。用户关闭侧栏时焦点回到入口，载入示例成功后收起侧栏并聚焦主区域。

报告控制区与阅读文档分开。紧凑统计以文字和数字排列，允许换行。组件内边距承担实际留白；不要因外层未设置 padding 就删除子区域已提供的间距。

## Elevation & Depth

常规内容面通过底色、边框和分隔线建立深度，不附加卡片投影。对话框在遮罩上抬升，短时反馈浮于页面上方；这两种投影都有向下偏移。

### Shadow Vocabulary
- **对话框抬升**（`0 18px 60px rgb(21 45 62 / 22%)`）：录入与确认对话框；遮罩为（`rgb(18 38 54 / 45%)`）。
- **短时反馈**（`0 5px 22px rgb(23 60 85 / 18%)`）：深蓝 toast 在浅底上的轻投影。

**The Flat Workspace Rule.** 常规资料面保持平面；投影保留给当前实现中的对话框与短时反馈。

## Shapes

控件为轻圆角矩形（6px），主要内容容器与对话框为柔和圆角（12px），小状态标签为较紧圆角（4px）。步骤编号使用正圆；品牌图标是圆角深蓝底上的白色叠放文档轮廓。

区域边框以（1px）为主；步骤选中底线（3px），筛选选中底线（2px）。图标使用内联 SVG 细描边，通常（18px），保留 round 端点与连接。图形服务于操作或空态语义，不承担装饰性主视觉。

## Components

### Buttons

直接、明确的操作面。主要按钮为深蓝底白字，次要按钮为白底蓝灰边框，纳入按钮为绿色底白字。普通按钮内边距（9px 17px）、最小高度（42px）。链接式操作保留文字样式，hover 加下划线。

主要与次要按钮具备背景 hover 和 active 状态；纳入操作具备更深绿 hover。禁用状态降低透明度（0.55），光标表明不可操作。键盘焦点使用（2px）轮廓和（3px）偏移；深蓝顶栏按钮改用浅色焦点线。

### Chips

紧凑的文字状态标签，内边距（1px 6px）、字号（12px）。默认灰蓝底，纳入、待核实、不可用正文分别使用状态色对。它们是说明信息；交互筛选使用独立的底线按钮组。

### Cards / Containers

白色平面、细灰蓝边框、容器圆角。表单桌面内边距（28px 32px），报告（38px 48px）。来源列表与阅读区共享一个容器；子区用边线分隔，避免把每条记录再做成独立浮卡。

### Inputs / Fields

白底、蓝灰细边、控件圆角，最小高度（44px），内边距（10px 12px）。标签在上、说明或错误在下。hover 加深边框；焦点使用统一轮廓。`aria-invalid` 字段变为红色边框并显示错误文字。

### Navigation

步骤由圆形编号、步骤名和桌面辅助说明构成。当前步骤同时改变文字、底线和编号填色；未开放步骤的编号为虚线边。四步保留完整辅助说明与横向排列。筛选导航使用较轻的文字与底线，无填色胶囊。

### Source Records and Reading

来源记录的编号占独立列，标题、元数据和状态连续排在右侧。选中行使用浅蓝底，hover 为轻蓝灰；焦点轮廓向内偏移，避免滚动区裁切。原文区按编号、标题、字段、链接、核查提示、保存文本和操作排列；长链接允许折行。

### Dialogs and Feedback

录入与确认对话框使用同一白底与圆角，最大宽度分别（640px / 430px）、最大高度（92vh）。操作区在底部细分隔线上方留出间距。toast 为深蓝文字反馈面。输入与按钮的颜色、边框变化采用（160ms / cubic-bezier(.2, .8, .2, 1)）；系统偏好减少动态时取消 transition，不引入额外展示动画。

## Do's and Don'ts

### Do:
- **Do** 用文字与颜色共同标明审核状态，保持资料编号、详情与引用的对应。
- **Do** 沿用当前根变量和组件圆角、间距，新增区域先使用文字与分隔线建立层级。
- **Do** 保留键盘焦点、可折行内容与桌面双栏核查布局。
- **Do** 为长篇保存文本与简报保留阅读行长和宽松行距。

### Don't:
- **Don't** 回到用户已拒绝的通用 AI 模板表达，以装饰性英文标签或营销式大标题压过任务与资料。
- **Don't** 给普通资料面批量增加投影，或把每条来源做成独立悬浮卡片。
- **Don't** 仅凭颜色表达状态，或让焦点样式与当前选择混为一谈。
- **Don't** 将示例、未知状态或待核实内容包装为已证实成果。
