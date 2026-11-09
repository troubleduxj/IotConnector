# Factory Bridge UI 设计规范（v1.0）

> 本规范从现有高保真原型（`apps/console`）逆向提炼，是后期所有界面开发的**强制标准**。
> 新页面/新组件必须遵循本文档；修改规范需先更新本文档并评审。
> 技术载体：Tailwind CSS 4（类名即规范），后续抽离为 `packages/ui` 基础组件库时以本文档为验收依据。

---

## 1. 设计原则

1. **工业级信息密度**：数据优先，装饰克制；一屏内尽量少滚动完成巡检。
2. **状态即颜色**：颜色只用于表达状态与层级，禁止无语义的彩色装饰。
3. **数字是主角**：一切运行数值使用等宽数字（`font-mono` / `tabular-nums`），单位弱化显示。
4. **暗色 = 工业现场，亮色 = 管理界面**：导航与代码/报文区用深色，工作区用浅色。
5. **危险操作必须有摩擦**：写 PLC、下发配方、删除配置必须二次确认 + 鉴权 + 审计（配合 PRD FR-M10-06）。

---

## 2. 色彩系统

### 2.1 中性色（slate 阶梯）

| 用途 | Token |
|---|---|
| 应用背景 | `bg-[#F8FAFC]`（slate-50） |
| 侧栏 / 代码与报文深色面板 | `bg-slate-900`，深面板内分层 `bg-slate-800` |
| 卡片背景 | `bg-white` |
| 区块头部底色 | `bg-slate-50` |
| 主文字 | `text-slate-900` / 标题 `text-slate-800` |
| 次要文字 | `text-slate-600` / `text-slate-500` |
| 占位、弱标签 | `text-slate-400` |
| 边框 | 外框 `border-slate-200`，分隔线 `border-slate-100` |
| 深面板边框 | `border-slate-700` |

### 2.2 品牌主色（唯一）

| 用途 | Token |
|---|---|
| 主操作 / 选中态 / 焦点 | `indigo-600`（hover `indigo-700`） |
| 选中浅底 | `bg-indigo-50` + `text-indigo-700` |
| 焦点环 | `focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500` |
| Logo/头像底 | `bg-indigo-500`（实底）/ `bg-indigo-100`（浅底） |

> 一个界面只允许一个主色。secondary 按钮、图表曲线等其他色彩一律不得使用 indigo 之外的品牌色相（图表色板除外）。

### 2.3 语义状态色

| 状态 | 颜色 | 用法示例 |
|---|---|---|
| 正常 / 在线 / Good | `green-500`（点）/ `green-700`（文字）/ `bg-green-100 text-green-700 border-green-200`（徽章） | 在线徽章、质量 Good |
| 警告 / Moderate | `amber-400/500`、文字 `amber-600/700` | 负载 50-80%、告警数 |
| 严重 / 错误 / Heavy | `rose-500`（负载、危险按钮 hover 底 `rose-50`、文字 `red-600`） | 负载 >80%、删除 |
| 进行中 / 信息 | `blue-100`/`blue-600` 图标底 | 模块图标 |
| 禁用 / 离线 | `slate-300`、`bg-slate-100 text-slate-600` | 未启用任务 |

**状态点**：直径 `w-2 h-2 rounded-full`，可加 `animate-pulse` 表示活动。
**质量标识**：Good 用绿点 + 文字；Uncertain 黄点；Bad 灰显数值 + 红点。

### 2.4 协议色板（固定映射，不得改动或复用）

| 协议 | 主色 | 徽章 |
|---|---|---|
| Siemens Profinet/S7 | `cyan-500` | `text-cyan-600 border-cyan-300 bg-cyan-50` |
| OPC UA | `indigo-500` | `text-indigo-600 border-indigo-300 bg-indigo-50` |
| Modbus TCP | `amber-500` | `text-amber-600 border-amber-300 bg-amber-50` |
| EtherNet/IP (Rockwell) | `rose-500` | `text-rose-600 border-rose-300 bg-rose-50` |
| Mitsubishi MELSEC | `red-500` | `text-red-600 border-red-300 bg-red-50` |
| Omron FINS | `blue-500` | `text-blue-600 border-blue-300 bg-blue-50` |
| MQTT / Sparkplug B | `purple-500` | `text-purple-600 border-purple-300 bg-purple-50` |
| BACnet/IP | `emerald-500` | `text-emerald-600 border-emerald-300 bg-emerald-50` |
| IEC 60870-5-104 | `amber-600` | `text-amber-700 border-amber-400 bg-amber-50` |

来源：`apps/console/src/shared` 的 `PROTOCOL_CONFIGS`（color/bgColor 字段），前端不得另行硬编码。

### 2.5 图表多曲线色板（Historian 专用，8 色）

`#4f46e5, #059669, #d97706, #e11d48, #0891b2, #9333ea, #ea580c, #0d9488`

按位号选择顺序循环分配；同屏最多 8 条曲线（PRD FR-M7-01）。

---

## 3. 字体与排版

### 3.1 字体

- 界面：`font-sans`（系统栈：Inter / system-ui / PingFang SC / Microsoft YaHei，i18n 中文包络）。
- 代码、地址、报文、数值：`font-mono`。

### 3.2 字阶（严格使用以下档位）

| 层级 | 规格 | 用途 |
|---|---|---|
| Display | `text-3xl font-bold` | KPI 大数字 |
| 页面标题 | `text-lg font-bold text-slate-800` | 页内区块主标题 |
| 顶栏标题 | `text-lg font-semibold text-slate-800` | 全局 Header |
| 卡片标题 | `text-sm font-semibold/bold text-slate-800` | 卡片与面板标题 |
| 正文 | `text-sm text-slate-600` | 描述、表单值 |
| 标签/眉题 | `text-xs font-semibold text-slate-500 uppercase tracking-wider` | 字段 label、分组眉题 |
| 辅助说明 | `text-[11px] text-slate-500` | 提示文案、脚注 |
| 表头 | `text-[11px] uppercase font-bold tracking-wider text-slate-500` | 表格列头 |
| 微数据 | `text-[10px] font-mono text-slate-400` | 时间片刻度、报文注释 |

> 中文落地注意：uppercase/tracki­ng 仅对英文生效，中文 label 不加 `uppercase`；禁止小于 10px。

### 3.3 数值格式规范（配合 PRD 统一 `<TagValue>` 组件）

- 浮点：按位号精度（默认 2 位）；整型/计数：无小数。
- 单位：`text-sm text-slate-500 font-normal`，与数值基线对齐（`items-baseline`）。
- 布尔量：状态色块（RUNNING/STOPPED、ON/OFF），不允许显示 `true/false` 字面量。
- 值变化：数值更新时短暂高亮（新增标准：`transition-colors` 400ms 淡出至常规色）。

---

## 4. 布局系统

### 4.1 应用框架

```
┌──────────┬───────────────────────────────┐
│ Sidebar  │ Header h-16（white，底部边框）  │
│ w-64     ├───────────────────────────────┤
│ slate-900│ Content p-8（可滚动）           │
│          │   max-w-7xl mx-auto gap-6      │
└──────────┴───────────────────────────────┘
```

- 侧栏固定 `w-64`，`bg-slate-900`；导航项 `px-3 py-2 rounded-md text-sm`，选中 `bg-indigo-600 text-white`，悬停 `hover:bg-slate-800`。
- 导航分组眉题：`text-xs text-slate-500 uppercase tracking-wider px-3`（PRD 信息架构分组时沿用）。
- 移动端：侧栏变抽屉（`fixed inset-y-0 -translate-x-full` + 遮罩 `bg-slate-900/50 backdrop-blur-sm`），断点 `md:`。
- 底部状态卡：`bg-slate-800 m-4 rounded-lg`，显示 Sync Health 与版本号。

### 4.2 页面骨架

- 内容统一包裹：`max-w-7xl mx-auto flex flex-col gap-6`，外层 `p-8`。
- KPI 行：`grid grid-cols-1 md:grid-cols-3/4 gap-4/6`。
- 主从布局（列表-详情）：左列表 `w-64~w-72 shrink-0` + 右详情 `flex-1 min-w-0`；三栏（脚本页）`w-64 / flex-1 / w-80`，gap-6，高度 `h-[calc(100vh-140px)]`。

---

## 5. 组件规范

### 5.1 卡片（Card）

```html
<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
  <div class="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
    <!-- 标题区：图标(p-2 bg-{color}-100 rounded-lg) + 标题 + 右侧操作/徽章 -->
  </div>
  <div class="p-6"><!-- 内容 --></div>
</div>
```

KPI 卡变体：`p-5`，标签行（眉题 + 右上图标 `w-4 h-4 text-slate-400`）+ 大数字 + 底部说明文字。

### 5.2 按钮

| 类型 | 规格 |
|---|---|
| Primary | `px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors`（可加 `shadow-sm`） |
| Secondary | `px-4 py-2 bg-white border border-slate-300 text-slate-700 text-sm font-medium rounded-md hover:bg-slate-50` |
| Dark（下发/下载类强调） | `bg-slate-800 text-white hover:bg-slate-700` |
| Danger | `text-red-600 border-red-200 bg-white hover:bg-red-50`；图标按钮 `hover:text-red-600 hover:bg-red-50` |
| 图标按钮 | `p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors` + `title` 提示 |
| 按钮内图标 | `w-4 h-4 mr-2`，文字 `text-sm font-medium` |

### 5.3 表单控件

- 输入框：`px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500`；等宽内容加 `font-mono`；只读 `bg-slate-50 text-slate-500`。
- Label：`block text-xs font-semibold text-slate-600 mb-1.5`。
- 字段组网格：`grid grid-cols-1 md:grid-cols-2/3 gap-4`。
- 所有表单**必须受控**（禁止 `defaultValue` 漂浮态），保存走「保存 → 应用 → 生效」三态反馈（PRD FR-M9-01）。
- Toggle：`h-5 w-9` 胶囊 + `h-4 w-4` 圆点，开 `bg-indigo-600`，关 `bg-slate-200`；统一抽为 `<Toggle>` 组件（禁止再复制粘贴）。
- 滑块：`accent-indigo-600`（按协议可用对应协议色），右端当前值 `text-[10px] font-mono text-slate-400`。

### 5.4 表格

- 容器 `overflow-x-auto`；表头 `bg-slate-50`，规格见 §3.2；行 `border-b border-slate-100 hover:bg-slate-50 transition-colors`。
- 首列（名称/地址）`font-mono font-medium`；右对齐操作列 `text-right`。
- 空状态：`px-6 py-8 text-center text-slate-500 text-sm`，说明搜索词或引导动作。

### 5.5 徽章 / 芯片 / Tab

- 徽章：`px-2 py-0.5 rounded-full text-xs font-medium border`（配色见 §2.3/2.4）。
- 过滤芯片：`px-3 py-1.5 rounded-md text-xs font-medium`，选中 `bg-indigo-600 text-white`，未选 `text-slate-600 hover:bg-slate-100`。
- 页内 Tab：`px-4 py-3 text-sm font-medium`，选中 `text-indigo-600 border-b-2 border-indigo-600`，未选 `text-slate-500 hover:text-slate-700`，底部整体 `border-b border-slate-200`。

### 5.6 弹窗 / Toast / 反馈

- Modal：遮罩 `fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50`；容器 `bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md`；头部 `px-6 py-4 border-b`，底部操作区 `px-6 py-4 bg-slate-50 border-t`，右侧按钮组（Cancel = Secondary，确认 = Primary）。
- Toast：固定顶部居中或右上，深色 `bg-slate-900 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg`，3s 自动消失；保存类操作必须有 Toast 反馈。
- 危险确认：删除/写 PLC/下发必须弹确认 Modal，写操作显示 diff（当前值 → 目标值）。

### 5.7 深色技术面板（代码编辑器 / 报文抓包）

- 容器 `bg-slate-900 rounded-xl border border-slate-700 shadow-inner`；标题栏 `bg-slate-800 border-b border-slate-700 px-4 py-2`，含 mac 窗口点（`w-3 h-3 rounded-full bg-red-500/amber-500/emerald-500`）+ 文件名 `text-xs text-slate-400 font-mono`。
- 代码：`font-mono text-sm text-slate-300`，行号 `w-8 text-slate-600 select-none text-right`。
- 报文帧：TX 标签 `bg-amber-500/10 text-amber-400`，RX 标签 `bg-emerald-500/10 text-emerald-400`，帧体 `font-mono text-cyan-300`，注释 `text-slate-400`。
- 实时指示：`text-emerald-400` + `animate-pulse` 圆点 + 「LIVE」大写微标。

### 5.8 图标

- 统一 lucide-react；尺寸 `w-4 h-4`（行内/按钮）、`w-5 h-5`（导航/卡片头）、`w-6 h-6`（模块图标底）。
- 图标必须有 `title` 或伴随文字，禁止纯图标无语义。

---

## 6. 动效与过渡

| 场景 | 规格 |
|---|---|
| 通用 hover/颜色 | `transition-colors`（默认 150ms） |
| 侧栏抽屉 | `transform transition-transform duration-300` |
| 图表柱高/数值 | `transition-all duration-500` |
| 实时值刷新 | 背景色高亮 400ms 淡出（§3.3） |
| 加载态 | 按钮内 `animate-spin`（lucide `Loader2`），禁用其余按钮；表格首载用骨架条（`bg-slate-100 animate-pulse rounded`） |

禁止：弹跳、旋转等装饰性动画；图表动画时长 > 500ms。

---

## 7. 页面级规范摘要

| 页面 | 骨架 | 备注 |
|---|---|---|
| Dashboard | KPI 行(3) + 实时位号网格(3列卡片) | 数值必须实时；告警列表区预留 |
| Device Management | 左通道列表 w-80(过滤芯片+添加按钮) + 右详情(头部卡片 + 3 Tab) | 通道卡显示协议徽章/状态点/tag 数 |
| Acquisition Scheduler | KPI 行(4) + 左图(2/3) + 右调参(1/3) | 柱状图三色阈值 50/80 |
| Data Storage | 左任务列表 w-72 + 右配置详情 | — |
| Parameter Diagnose | 全宽表格 + 顶部搜索 | 写值走 Modal |
| Recipe Management | 双列卡片网格 | — |
| Historian | 顶部工具卡 + 左选择器 w-80 + 右图表 + 底部统计表 | — |
| Scripts | 三栏 w-64 / flex-1 / w-80 | 中栏深色面板 |
| System Config | 双列 xl:grid-cols-2 | 模块图标头 + 右上 Toggle |

---

## 8. 落地要求

1. 新页面开发前对照 §7 摘要与 §5 组件规格；不得发明新样式档位。
2. 通用组件（Toggle、Modal、Toast、Badge、TagValue、Card、状态点）收敛到 `apps/console/src/components/`，后续抽 `packages/ui`；禁止跨页面复制粘贴组件。
3. 协议色、图表色、语义色一律从 `apps/console/src/shared` 或本规范常量取用。
4. i18n：所有文案走语言资源文件（D3 决策，中文优先）；组件内禁止硬编码文案。
5. 违反本规范的代码不予合并（review 检查项）。
