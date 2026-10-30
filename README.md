# Magpie WorkBuddy Plus

Magpie 的第三方 WorkBuddy 国内版补充插件，提供成长任务、猫猫旅行、连登福利和后台定时。

**仅支持 WorkBuddy 国内版，不包含国际版活跃或国际版任务功能。** 只读取 Magpie 中 `workbuddy` 的国内账号，不读取 `workbuddy-ai` 国际账号。企业账号可以检查登录续期，个人成长奖励会跳过。

这是独立的非官方项目。Magpie 的 WorkBuddy 插件继续负责账号登录、模型、API 转发和每日签到。WorkBuddy Plus 只补充每日签到以外的国内成长任务、旅行、连登福利与定时，不调用每日签到接口。

## 功能

- 国内成长中心的连登活跃与福利检查。
- 成长任务接取、事件上报、进度核对与领奖；未达成时不会记为已领奖。
- 猫猫旅行派出、归来领奖；首次使用时处理 `first_buddy`。
- 成长中心的连登补签卡、7/14/28 天连登兑换、成长抽奖、新手礼包与活动补偿检查；这里的连登补签与每日签到领取积分是不同活动。
- 夜猫子任务按北京时间的有效窗口执行，每号每天最多上报一次。
- 登录续期检查、定时执行、失败重试、休眠后补跑当天已到的时段、重启去重。
- 账号看板，三种视图可切换：「列表」是汇总和每个账号一行（积分条按作废先后着色、今日圆环、7 天走势，点开看详情），最下方列出需要你处理的事（10 天内作废的积分、需手动完成的任务、读取失败或登录将过期的账号）；「圆环」一次看一个账号的今日圆环（活跃、旅行、任务）、积分作废时间线和用量；「小组件」按一件事一块汇总所有账号。内容包括各账号可用积分、积分包与作废时间、近 7 天官方用量（按天与模型）、猫猫旅行状态卡；成长任务进度（可领奖、定时会完成、需手动）、能量、Buddy 图鉴与抽奖次数、连登天数、补签卡和下一档奖励。只读，每 10 分钟随后台服务刷新。
- Magpie 侧栏页面：在 Magpie 里直接看账号看板和最近执行，并可刷新、派出旅行、全部执行、暂停或开启定时。
- 「添加账号」：打开 Magpie 官方 WorkBuddy 插件的浏览器登录（`magpie plugin login workbuddy`），登录后账号直接出现在看板；同一账号重新登录会替换原来的登录。本插件不接触登录令牌，也不提供账号文件导入导出。
- 本机网页面板：选择账号、一键执行、查看最近 100 次记录、调整时段或暂停定时，同样带账号看板。

成长任务包含模拟客户端事件上报，不代表实际在桌面端完成操作。是否计入进度、发放奖励或限制账号由上游决定，不保证所有任务都能完成。公众号关注、实际捐赠和部分桌面操作需要本人完成；已达成的任务可以尝试领奖。

## 安装

需要 Magpie。先在 Magpie 安装官方 WorkBuddy 插件、登录国内账号并开启每日自动签到，无需给本项目重新提供账号密码。

在 Magpie「插件 → 发现 → 非官方」中搜索本项目，或直接安装仓库：

```sh
magpie plugin add github:sabercomo/magpie-workbuddy-plus
```

装上就能用：Magpie 启动或重载插件时，插件会检查本机服务，没有在运行就从插件目录启动它，并让它把看板快照写进这份插件的页面目录。之后在 Magpie 侧栏打开「WorkBuddy Plus」，或打开 **http://127.0.0.1:3439**，确认账号列表，再点击「开启定时」。**首次安装默认暂停定时**；手动操作不受定时开关影响。

服务由 Magpie 启动后独立运行，页面按钮让 Magpie 重载插件、插件更新，都不会打断正在执行的任务；退出 Magpie 后服务会继续运行到注销或关机。要登录时自动开始，可以开启 Magpie 的登录启动（`magpie autostart on`），或使用下面的后台安装。

### 可选：macOS 登录后独立运行

想在不打开 Magpie 时也照常执行，用 LaunchAgent 安装。需要 Git 和 Bun 1.3+，且 `magpie`、`bun` 命令可在终端使用。

```sh
git clone https://github.com/sabercomo/magpie-workbuddy-plus.git
cd magpie-workbuddy-plus
bun install.mjs
```

安装器会把运行文件复制到 `~/Applications/Magpie-WorkBuddy-Plus`，注册 Magpie 插件，并创建登录后自动启动的 macOS LaunchAgent；同一安装目录已有的其他 LaunchAgent 会被停用并改名为 `.replaced`。安装后可删除下载的源码目录。

同一时间只有一个服务占用端口：LaunchAgent 和 Magpie 同时启动服务时，后启动的那个待命，等前一个退出后再接手，不会重复执行。电脑休眠时暂停，唤醒并恢复联网后补跑当天已经到点的任务；夜猫子任务只能在有效夜间窗口执行。关机期间不执行。

在「插件 → 已安装」的插件卡片中可以查看工具名并复制 Magpie MCP 地址。工具包括：

| 工具 | 用途 |
| --- | --- |
| `status` | 查看国内账号、执行记录和定时设置 |
| `run` | 启动指定操作；`all` 包含活跃、成长任务、旅行和连登福利 |
| `schedules` | 查看或开关定时；具体时段在网页面板调整 |
| `board` | 查看账号看板：积分、积分包作废时间、近 7 天用量、旅行与连登 |

插件还带一个 Magpie 页面「WorkBuddy Plus」。Magpie 的插件页面运行在不能联网的沙箱中，所以页面读取后台服务写出的 `page/data.js`（只有余额、用量与旅行状态，不含登录凭证），每 15 秒重新载入。页面上的按钮通过保存插件选项提交请求，Magpie 会因此重载一次插件，再由插件转交后台服务；同一请求只执行一次，超过 10 分钟的请求会被拒绝。页面需要后台服务在运行；数据超过 25 分钟未更新时会提示。

仓库使用 `magpie-plugin` GitHub 主题供 Magpie 非官方发现区检索；这不代表 Magpie 维护者审核或推荐。

## 默认定时

全部按 `Asia/Shanghai` 时区，可在面板修改。清空某类时段可以关闭该类。

| 时间 | 操作 |
| --- | --- |
| 01:00 | 国内夜猫子任务 |
| 09:00、21:00 | 国内活跃、猫猫旅行、连登福利 |
| 09:10、21:10 | 国内成长任务 |
| 22:00 | 登录续期检查，提前两小时续期 |

每 30 秒检查一次定时。失败至少间隔 15 分钟重试，每个时段最多尝试 3 次。上游限流（HTTP 429）时先在本次执行里等待后重试；仍被限流的执行记为「稍后重试」而不是失败，同样按上面的间隔补跑。每类时段最多 24 个；看板底部的「今日定时」列出今天每个时段的结果和下一次执行。连登活跃成功后当天不重复；旅行与任务奖励会核对上游状态。每日签到按 Magpie 自身的设置执行，不属于本插件的定时任务。

## 终端操作

在下载的源码目录或安装目录中运行：

```sh
bun cli.mjs status
bun cli.mjs run all
bun cli.mjs run travel
bun cli.mjs board
bun cli.mjs pause
bun cli.mjs resume
```

`run` 还支持 `activity`、`tasks`、`bonus`、`night`、`keepalive`、`inspect`。操作会返回执行编号，随后在面板或 `status` 中查看结果。

## 其他平台手动运行

其他平台同样可以用 `magpie plugin add` 安装，由 Magpie 启动服务；这部分只在 macOS 上验收过。macOS 以外没有登录自启的安装器，想不开 Magpie 也运行时，安装 Bun 并登录国内账号后，可以在源码目录运行：

```sh
bun server.mjs
```

保持进程运行，并在面板开启定时。需要开机自启时，请自行配置所在系统的后台服务；这部分尚未完成跨平台验收。

## 设置与数据

| 位置 | 内容 |
| --- | --- |
| `~/.config/workbuddy-plus/config.json` | 定时、账号开关与 HTTP 代理设置 |
| `~/.config/workbuddy-plus/state.json` | 执行记录及去重状态 |
| `~/.config/workbuddy-plus/service.log` | 后台服务日志 |
| 安装目录下 `page/data.js` | 给 Magpie 页面的看板快照，由后台服务改写 |
| `~/Library/LaunchAgents/io.github.sabercomo.magpie-workbuddy-plus.plist` | macOS 后台启动配置 |

默认复用 `~/.config/magpie/plugin-auth.json` 的国内登录。Magpie 使用自定义配置目录时，遵循 `XDG_CONFIG_HOME`，也可以用 `WORKBUDDY_PLUS_MAGPIE_DIR` 指向其配置目录；`WORKBUDDY_PLUS_DIR` 可指定本插件数据目录，`WORKBUDDY_PLUS_PORT` 可修改服务端口。

账号看板只读取 `get-user-resource`（积分包；企业账号改读 `get-enterprise-user-usage` 的每月额度）、`get-user-request-usage`（官方用量，只统计积分、次数和模型，不保存请求内容）和成长中心的任务、能量、Buddy 图鉴、抽奖次数、旅行与连登状态，不领取或消耗任何东西。企业账号只显示用量。

当前通过本机账号文件适配 Magpie，登录续期使用相同的文件锁与账号锁。Magpie 存储格式变化时可能需要更新本插件。发布源码不需要包含个人账号文件、配置或运行记录。

服务只监听 `127.0.0.1`。在面板可填写 HTTP 代理；代理请求需要 Bun。Node.js 22+ 可以执行测试或运行不使用代理的服务。

## 更新与停用

源码安装的后台版本：在源码目录更新后重新安装，已有配置与记录保留。

```sh
git pull --ff-only
bun install.mjs
```

在 Magpie 中停用插件只会停用工具入口。**要停止自动任务，先在面板点击「暂停定时」**，或执行 `bun cli.mjs pause`。

macOS 后台安装的版本可按下面的步骤停止服务并移除工具入口：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.github.sabercomo.magpie-workbuddy-plus.plist"
magpie plugin rm "$HOME/Applications/Magpie-WorkBuddy-Plus"
```

随后可删除安装目录和上述 plist。`~/.config/workbuddy-plus` 中的设置与执行记录可以保留。如果曾另外按仓库地址安装过插件，也在 Magpie 已安装列表中移除对应条目。

## 开发与验证

无需安装 npm 依赖，测试使用模拟账号和模拟上游，不会访问个人账号或真实奖励接口。

```sh
npm test
```

测试覆盖国内账号筛选、国际账号排除、凭证不出现在状态响应、全部执行不调用每日签到、成长任务进度、旅行领奖、积分包合并与作废时间、成长任务分类、用量分页、看板快照不含凭证、页面请求去重、登录续期竞争、定时去重、面板操作和本机 HTTP 边界。

## 许可与来源

MIT。沿用的任务编号、接口与登录字段实现来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
