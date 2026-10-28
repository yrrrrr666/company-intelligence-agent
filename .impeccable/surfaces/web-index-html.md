---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/styles.css","web/app.mjs","web/favicon.svg"]
---

# 研究工作台

模式：Operate；研究简报正文按 Read 的阅读要求处理。范围：web/index.html、web/styles.css、web/app.mjs、web/favicon.svg。用户确认保留四步流程、整体平衡并统一布局与视觉规范；已明确选择“来源与状态：顶部四步导航，研究范围固定展示，资料与原文并排”。

## Direction contract

THESIS：公司范围、来源和人工选择构成研究依据。每页先展示任务与操作，移除营销式大标题、英文装饰标签、重复流程说明和卡片套卡片。

OWN-WORLD：受资料索引与图例的清晰语义启发：深蓝顶栏、冷白工作区、浅蓝研究范围带；使用常规系统无衬线字体、14px 正文、12px 辅助信息。蓝色表示当前步骤，绿色表示纳入，琥珀表示待核实，均配文字。

STORY：依次定义研究、收集资料、审核资料、整理简报。资料始终保留原文与来源，用户明确纳入后才参与简报。特征交互是资料编号与核查状态在列表、正文和引用中的连续对应。

FIRST VIEWPORT：深蓝顶部产品栏下为横向四步导航。创建页左侧直接显示表单，右侧为虚构示例的实际内容与入口；其他页面首先显示固定字段的研究范围带。审核页左侧可筛选来源、右侧正文与审核操作；统计用紧凑文字而非大数字卡片。简报页控制栏与文档分离。窄屏导航仍可点选，选择资料后正文进入视口。

FORM：七个具象方向的第七项“资料索引与状态图例”；seed:ebb78fac59b14296。借鉴其他方向的信息密度、固定字段位置和清晰层级，不借用其装饰。采用代码实现，未生成设计图片。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
