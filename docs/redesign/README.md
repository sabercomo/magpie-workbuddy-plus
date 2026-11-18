# WorkBuddy Plus 视觉重设计稿

这两套稿只改信息架构与视觉层，不动任务、账号和凭证逻辑。截图使用 `docs/demo-data.mjs` 的虚构账号。

## 诊断

当前「列表 / 任务 / 圆环 / 小组件 / 模型」把三种东西放在同一排：

- 同一批账号的三种呈现方式：列表、圆环、小组件；
- 一个真正的目的地：任务；
- 一个参考库：模型。

所以切换起来像在换「看法」，而不是在换「地方」。任务加进来后，这个问题更明显。

## 方案 A：三入口工作台（推荐）

顶部只保留三个目的地：**今天 / 账号 / 任务**。

- 「今天」把列表、圆环、小组件收成一张总览：账号卡自带迷你圆环、积分、今日进度和下一步动作。
- 「账号」保留完整账号列表与详情，不再把圆环/小组件当顶层视图。
- 「任务」是跨账号待办队列，有筛选、单项执行和「执行全部待办」。
- 「模型」从顶层标签降为工具入口：宽屏在左侧栏底部，窄屏在顶栏图标。
- Magpie 窄侧栏使用底部悬浮三标签；本地宽面板使用左侧悬浮栏。

对应文件：

- `ui-a-overview.html` / `a-overview.png`
- `ui-a-overview.html` / `a-narrow.png`
- `ui-a-tasks.html` / `a-tasks.png`

## 方案 B：单页驾驶舱（宽屏备选）

彻底取消视图切换：

- 左侧是账号列表，选中即切换账号；
- 中间是当前账号的完整工作区；
- 右侧是跨账号待办队列；
- 「模型」放在顶栏，用 sheet 打开；
- 窄屏需要退回方案 A 的底部导航，因此这套更适合宽面板/桌面。

对应文件：`ui-b-workbench.html` / `b-workbench.png`

## 方案 A2：主流应用壳（当前推荐）

这一版把 A 的「圆角悬浮侧栏」收平，按 Linear、Vercel、Asana 这类专业工具的共同结构来做：

- 顶层只有 **今天 / 账号 / 任务** 三个目的地；模型、设置降为工具区。
- `列表 / 圆环 / 小组件` 移到账号页内部，作为同一批账号的显示方式，不再和任务平级。
- 账号详情从右侧打开，内部再分 `概览 / 任务 / 积分 / 用量`；窄屏改为全屏推入并返回。
- 任务页是 Inbox：筛选、按账号分组、行内领奖/执行，执行队列只作为右侧上下文。
- 宽屏用全高平直侧栏 + 顶栏上下文/主操作；窄屏用底部三标签 + 顶栏工具按钮。
- 浅色/深色 token、reduced-motion、reduced-transparency 和 contrast 偏好均已写入。

对应文件：

- `a2-shell.html` / `a2-today.png`
- `a2-shell.html?view=tasks` / `a2-tasks.png`
- `a2-shell.html?view=accounts&account=1` / `a2-accounts.png`
- `a2-shell.html?view=today`（390px）/ `a2-narrow.png`
- `a2-shell.html?view=accounts&account=1`（390px）/ `a2-account-narrow.png`
- `a2-tasks-narrow.png`
- 深色主题：`a2-dark.png`

可直接打开 `a2-shell.html` 点侧栏、账号行和返回按钮。查询参数只用于截图，不参与真实数据。

### 主流对照

- [Linear navigation](https://linear.app/enablement/guides/navigating-linear)：左侧主航导，顶栏放当前上下文和操作，详情以侧边 peek 展开。
- [Asana navigation](https://asana.com/guide/help/fundamentals/navigating-asana)：Home / Inbox / My tasks 是稳定目的地，展示方式留在对象内部。
- [Vercel dashboard navigation](https://vercel.com/changelog/new-dashboard-navigation-available)：导航收进可折叠侧栏，窄屏改底部栏，不再用一排平级 tabs。
- [Shopify Polaris navigation](https://polaris-react.shopify.com/components/navigation)：应用壳的侧栏、顶栏和内容层级分离。
- [NN/g: tabs used right](https://www.nngroup.com/articles/tabs-used-right/)：tabs 用于同一对象的不同视图，不用于一级页面导航。
- [Master-detail pattern](https://uxpatternsguide.com/patterns/master-detail)：宽屏列表 + 详情，窄屏列表 → 详情 → 返回。

品牌图标使用 `page/icon.svg`；该文件与 `workbuddy.cn` 当前站点 favicon 的 `logo.svg` 完全一致。

## 视觉与交互

- 品牌绿作为唯一强调色；纸色偏暖，减少「后台管理系统」的冷灰感。
- 系统字体 + SF Mono 数字；标题负字距、正文正常字距。
- 状态用圆点 + 文字，不用满屏 pill。
- 卡片只承载一个层级；不在卡片里再套卡片。
- 宽屏左栏与窄屏底栏使用半透明材质；滚动内容从下面穿过。
- 账号详情用可中断的 sheet 从触发卡片展开；默认 spring 阻尼 1.0、响应 0.3–0.4s。
- 按压反馈在 pointer-down 立即出现；`prefers-reduced-motion` 下改为 150ms 内透明度变化。
- 已在 320 / 375 / 390 / 414 / 720 / 768 / 1024 / 1440 宽度验证无横向滚动。

## 下一步

先确认 A2 的层级与视觉。确认后再改生产文件；预计只改 `page/index.html`、`page/app.js`、`page/board.js`、`page/board.css` 与 `page/style.css`，不删除现有数据和执行链路。

重新截图：

```sh
node docs/redesign/shot.mjs "file://$PWD/docs/redesign/ui-a-overview.html" 1440 1000 docs/redesign/a-overview.png
node docs/redesign/shot.mjs "file://$PWD/docs/redesign/ui-a-overview.html" 390 844 docs/redesign/a-narrow.png
node docs/redesign/shot.mjs "file://$PWD/docs/redesign/a2-shell.html?view=today" 1440 1000 docs/redesign/a2-today.png
node docs/redesign/shot.mjs "file://$PWD/docs/redesign/a2-shell.html?view=tasks" 1440 1000 docs/redesign/a2-tasks.png
node docs/redesign/shot.mjs "file://$PWD/docs/redesign/a2-shell.html?view=accounts&account=1" 1440 1000 docs/redesign/a2-accounts.png
SCHEME=dark node docs/redesign/shot.mjs "file://$PWD/docs/redesign/a2-shell.html?view=today" 1440 1000 docs/redesign/a2-dark.png
```
