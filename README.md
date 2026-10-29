# Magpie WorkBuddy Plus

Magpie 的第三方 WorkBuddy 国内版补充插件，提供 Buddy 加油站签到、成长任务、猫猫旅行、连登福利和后台定时。

**仅支持 WorkBuddy 国内版，不包含国际版活跃或国际版任务功能。** 只读取 Magpie 中 `workbuddy` 的国内账号，不读取 `workbuddy-ai` 国际账号。企业账号可以检查登录续期，个人成长奖励会跳过。

这是独立的非官方项目。Magpie 的 WorkBuddy 插件继续负责账号登录、模型和 API 转发；WorkBuddy Plus 负责国内活动与定时，不提供模型转发。

## 功能

- Buddy 加油站每日签到、国内连登活跃。
- 成长任务接取、事件上报、进度核对与领奖；未达成时不会记为已领奖。
- 猫猫旅行派出、归来领奖；首次使用时处理 `first_buddy`。
- 补签卡、7/14/28 天连登兑换、成长抽奖、新手礼包与活动补偿检查。
- 夜猫子任务按北京时间的有效窗口执行，每号每天最多上报一次。
- 登录续期检查、定时执行、失败重试、休眠后补跑当天已到的时段、重启去重。
- 本机网页面板：选择账号、一键执行、查看最近 100 次记录、调整时段或暂停定时。

成长任务包含模拟客户端事件上报，不代表实际在桌面端完成操作。是否计入进度、发放奖励或限制账号由上游决定，不保证所有任务都能完成。公众号关注、实际捐赠和部分桌面操作需要本人完成；已达成的任务可以尝试领奖。

## 安装：macOS 后台运行

需要已安装 Magpie、Git 和 Bun 1.3+，且 `magpie`、`bun` 命令可在终端使用。先在 Magpie 安装官方 WorkBuddy 插件并登录国内账号，无需给本项目重新提供账号密码。

```sh
git clone https://github.com/sabercomo/magpie-workbuddy-plus.git
cd magpie-workbuddy-plus
bun install.mjs
```

安装器会把运行文件复制到 `~/Applications/Magpie-WorkBuddy-Plus`，注册 Magpie 工具插件，并创建登录后自动启动的 macOS LaunchAgent。安装后可删除下载的源码目录。

打开 **http://127.0.0.1:3439**，确认账号列表，再点击「开启定时」。**首次安装默认暂停定时**；手动操作不受定时开关影响。

后台服务独立于 Magpie 运行。电脑休眠时暂停，唤醒并恢复联网后补跑当天已经到点的任务；夜猫子任务只能在有效夜间窗口执行。关机期间不执行，重新登录后后台自动启动。

## 在 Magpie 中安装与发现

在 Magpie「插件 → 发现 → 非官方」中搜索本项目，或直接安装仓库：

```sh
magpie plugin add github:sabercomo/magpie-workbuddy-plus
```

这种方式添加工具入口，**不会执行上面的 macOS 后台安装器**。第一次通过 Magpie 的插件工具调用 `status`、`run` 或 `schedules` 时，会按需启动本机服务，然后可打开面板。要登录后自动启动，请使用上一节的安装方式。

在「插件 → 已安装」的插件卡片中可以查看工具名并复制 Magpie MCP 地址。工具包括：

| 工具 | 用途 |
| --- | --- |
| `status` | 查看国内账号、执行记录和定时设置 |
| `run` | 启动指定操作；`all` 包含签到、活跃、成长任务、旅行和连登福利 |
| `schedules` | 查看或开关定时；具体时段在网页面板调整 |

仓库使用 `magpie-plugin` GitHub 主题供 Magpie 非官方发现区检索；这不代表 Magpie 维护者审核或推荐。

## 默认定时

全部按 `Asia/Shanghai` 时区，可在面板修改。清空某类时段可以关闭该类。

| 时间 | 操作 |
| --- | --- |
| 01:00 | 国内夜猫子任务 |
| 09:00、21:00 | 国内签到、活跃、猫猫旅行、连登福利 |
| 09:10、21:10 | 国内成长任务 |
| 22:00 | 登录续期检查，提前两小时续期 |

每 30 秒检查一次定时。失败至少间隔 15 分钟重试，每个时段最多尝试 3 次。签到与连登成功后当天不重复；旅行与任务奖励会核对上游状态。

## 终端操作

在下载的源码目录或安装目录中运行：

```sh
bun cli.mjs status
bun cli.mjs run all
bun cli.mjs run travel
bun cli.mjs pause
bun cli.mjs resume
```

`run` 还支持 `checkin`、`activity`、`tasks`、`bonus`、`night`、`keepalive`、`inspect`。操作会返回执行编号，随后在面板或 `status` 中查看结果。

## 其他平台手动运行

macOS 以外的平台没有自动安装器。安装 Bun、Magpie 并登录国内账号后，可以在源码目录运行：

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
| `~/Library/LaunchAgents/io.github.sabercomo.magpie-workbuddy-plus.plist` | macOS 后台启动配置 |

默认复用 `~/.config/magpie/plugin-auth.json` 的国内登录。Magpie 使用自定义配置目录时，遵循 `XDG_CONFIG_HOME`，也可以用 `WORKBUDDY_PLUS_MAGPIE_DIR` 指向其配置目录；`WORKBUDDY_PLUS_DIR` 可指定本插件数据目录，`WORKBUDDY_PLUS_PORT` 可修改服务端口。

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

测试覆盖国内账号筛选、国际账号排除、凭证不出现在状态响应、签到业务失败、成长任务进度、旅行领奖、登录续期竞争、定时去重、面板操作和本机 HTTP 边界。

## 许可与来源

MIT。沿用的任务编号、接口与登录字段实现来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
