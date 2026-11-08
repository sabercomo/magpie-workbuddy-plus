<div align="center">

# WorkBuddy Plus

**A companion plugin for WorkBuddy in Magpie (China and WorkBuddy AI)**<br>
Growth tasks, Buddy travel, login-streak rewards and schedules, plus one board that shows every account at a glance.

[![Tests](https://github.com/sabercomo/magpie-workbuddy-plus/actions/workflows/test.yml/badge.svg)](https://github.com/sabercomo/magpie-workbuddy-plus/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

[简体中文](README.md) · **English**

<img src="docs/images/list.png" alt="WorkBuddy Plus inside Magpie: the account list view" width="880">

</div>

> [!NOTE]
> An unofficial project for WorkBuddy China (the `workbuddy` accounts in Magpie) and WorkBuddy AI, the international build (`workbuddy-ai`). Sign-in, models and API forwarding stay with Magpie's WorkBuddy plugin. **China's daily check-in stays with Magpie** and this plugin never calls China's check-in; Magpie doesn't check in on WorkBuddy AI, so this plugin does, whenever WorkBuddy AI runs a check-in campaign.
>
> The plugin's page and messages are in Chinese. This README gives the Chinese names of buttons and views in quotes so you can find them.

## At a glance

| | |
| --- | --- |
| **Works once installed** | One `magpie plugin add` command. Magpie starts the background service when it launches, and a "WorkBuddy Plus" page appears in its sidebar. |
| **Runs the tasks for you** | Login-streak activity, growth tasks (accept and claim), Buddy travel (send out and claim), streak rewards and the night-owl task, on a schedule, retried on failure. |
| **Account board** | Each account's credits, when each credit package lapses, the last 7 days of usage, and travel and task progress, in switchable views. |
| **Which models you can use** | The Models view (「模型」) lists both builds' models with their ids, context and credit multipliers, sets WorkBuddy AI's Pro-only models apart, and marks subscriber priority and running promotions. |
| **WorkBuddy AI too** | With a WorkBuddy AI login in Magpie, that account is kept active daily, its streak tiers are redeemed, and it checks in whenever a campaign runs. On by default; both the page and the panel have 「关闭国际版任务」 (turn off international tasks). |
| **What needs you** | Credits about to lapse, enterprise allowance resets, tasks only you can do and logins about to expire, gathered at the bottom of the board. |
| **Add accounts** | A button opens WorkBuddy's official browser sign-in; this plugin never handles a token. |

## Screenshots

Taken from the plugin's page inside Magpie; every account and figure is made-up demo data.

<table>
  <tr>
    <td width="50%"><img src="docs/images/models-intl.png" alt="Models view: WorkBuddy AI"><br><sub><b>Models · WorkBuddy AI</b>: what a Free account can use first, Pro-only models dimmed below; each model's id, context and credit multiplier</sub></td>
    <td width="50%"><img src="docs/images/models-cn.png" alt="Models view: WorkBuddy China"><br><sub><b>Models · China</b>: all usable, with subscriber priority, limited-time free and night discounts marked</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/rings.png" alt="Rings view"><br><sub><b>Rings</b>: one account at a time, today's activity, travel and task rings, a credit lapse timeline and usage</sub></td>
    <td width="50%"><img src="docs/images/widgets.png" alt="Widgets view"><br><sub><b>Widgets</b>: one fact per tile, summed across accounts</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/alerts.png" alt="Today's schedule and alerts"><br><sub><b>Schedule and alerts</b>: how each slot went, the next run, and what needs you</sub></td>
    <td width="50%"><img src="docs/images/dark.png" alt="Dark mode"><br><sub><b>Dark mode</b>: follows Magpie's theme</sub></td>
  </tr>
</table>

## Install

First install Magpie's official WorkBuddy plugin, sign in to your China accounts and turn on the daily check-in. You never give this project a password.

Search for this project under Magpie's Plugins → Discover → Unofficial (「插件 → 发现 → 非官方」), or install it directly:

```sh
magpie plugin add github:sabercomo/magpie-workbuddy-plus
```

Then open "WorkBuddy Plus" in Magpie's sidebar (or **http://127.0.0.1:3439**), check the account list and click 「开启定时」 (start schedules). **Schedules are paused after a fresh install**; manual runs work either way.

Whenever Magpie starts or reloads plugins, the plugin checks for the local service and starts it from the plugin folder if it isn't running. The service runs on its own: page buttons that make Magpie reload the plugin, and plugin updates, don't interrupt a running job, and it keeps running after you quit Magpie until you log out or shut down. To start it at login, turn on Magpie's login launch (`magpie autostart on`) or use the background install below.

<details>
<summary><b>Optional: run at login on macOS, without Magpie open</b></summary>

Needs Git and Bun 1.3+, with `magpie` and `bun` available in the terminal.

```sh
git clone https://github.com/sabercomo/magpie-workbuddy-plus.git
cd magpie-workbuddy-plus
bun install.mjs
```

The installer copies the runtime files to `~/Applications/Magpie-WorkBuddy-Plus`, registers the Magpie plugin and creates a macOS LaunchAgent that starts at login; any other LaunchAgent for the same folder is unloaded and renamed `.replaced`. You can delete the source folder afterwards.

Only one service holds the port at a time: when the LaunchAgent and Magpie both start one, the later one waits and takes over when the first exits, so nothing runs twice. The service pauses while the computer sleeps and, once awake and online, catches up on the day's slots that came due; the night-owl task only runs inside its night window. Nothing runs while the computer is off.

</details>

<details>
<summary><b>Windows and other platforms</b></summary>

On Windows and Linux, install with `magpie plugin add` too and let Magpie start the service; `bun install.mjs` above is macOS-only and exits with an error elsewhere. Verified on Windows 10 through Magpie; Linux is not yet verified.

Windows reserves some port ranges (for Hyper-V, WSL and others), and the default port 3439 may fall inside one or be taken by another program, including Windows' own HTTP service. The service then doesn't start and writes the reason to `%USERPROFILE%\.config\workbuddy-plus\service.log`. List the reserved ranges with `netsh interface ipv4 show excludedportrange protocol=tcp` and pick a port outside them (see Port under Settings and data).

To run without Magpie, install Bun, sign in to your China accounts and run this in the source folder:

```sh
bun server.mjs
```

Keep it running and start the schedules in the panel. Starting it at boot is up to your system's service manager; that part isn't verified across platforms yet.

</details>

## Features

**Automatic tasks**

- Login-streak activity and reward checks in the China growth center.
- Growth tasks: accept, report events, check progress and claim; a task not reached is never recorded as claimed.
- Buddy travel: send out and claim on return; handles `first_buddy` on first use.
- Streak make-up cards, 7/14/28-day streak exchanges, growth draws, starter packs and event compensation checks. This streak is a different event from the daily check-in credits.
- **WorkBuddy AI (international)**, on by default and turned off with 「关闭国际版任务」 on the page or panel: daily activity that lights the heatmap and builds the streak; the 14-day (+50 credits) and 28-day (+150) tiers redeemed automatically; and the daily check-in whenever WorkBuddy AI runs a campaign (Magpie checks in on China only; as of 2026-11 WorkBuddy AI answers 「签到活动未开启或已过期」, no campaign running, and the plugin starts claiming once one does). WorkBuddy AI's growth tasks (its 「养虾」 levels) count real use of its client and can't be simulated, so they're listed as 「需在国际版客户端完成」 (do in the WorkBuddy AI client); it has no Buddy travel, so none is asked for, logged or shown, and its board rings are just activity and growth tasks.
- The night-owl task runs inside its valid window in Beijing time, at most once per account per day.
- Login renewal checks (China and WorkBuddy AI alike, under the file locks Magpie uses, so neither overwrites the other), retries, catch-up after sleep for the day's slots, and no double runs after a restart.

**Account board** (read only; refreshes with the service every 10 minutes, and shows China accounts signed in or out in Magpie within half a minute; claims or spends nothing)

- Credit history (「积分流水」): WorkBuddy keeps every grant (a check-in, a task reward, a Buddy's trip…) as its own entry with the time it was given. An account's detail lists the week's grants: when, how much, where from, what's left and when it lapses, under totals by source (say 「每日签到 +700 · 成长任务 +200 · 猫猫旅行 +43」) and the credit used meanwhile. The source is read from the line of this plugin's run log with the same time and amount, and China's daily check-in from Magpie's check-in time; a grant matching neither shows its package name.
- Deductions (「扣分明细」): in the detail's right column, beside the credit history, the week's 50 most recent requests that cost credit, one row each: when, how much (to two decimals), the model and the client that sent it. Ten show; the rest open under 「再显示」. Above them, how many requests were charged and how many were free; older requests count only in the totals.
- An account's 「成长」 (energy, Buddies, the next streak tier and open tasks) starts folded; click 「任务 x/y ▾」 to open it.
- A package is counted grant by grant: every reward in 「国内运营裂变包」, for one, is its own grant with its own 20 days, so only the grants about to lapse turn red and count as lapsing, never the whole package.
- List (「列表」): totals and one row per account (credit bar coloured by each grant's own lapse date, today's rings, a 7-day trend); open a row for packages, usage, tasks and travel.
- Rings (「圆环」): one account at a time with today's rings (activity, travel, tasks), a credit lapse timeline and usage.
- Widgets (「小组件」): one fact per tile across all accounts: next lapse, today, Buddies, energy, credits, 7-day usage, growth tasks.
- Models (「模型」): switch between China (「国内版」) and WorkBuddy AI (「国际版」). Models the current plan can use come first; WorkBuddy AI's Pro-only models are dimmed below. Each row has the model id (click to copy), context and multiplier; multipliers of 3 or more are orange, and limited-time free, night discounts and subscriber priority follow WorkBuddy's own labels. WorkBuddy AI needs a `workbuddy-ai` sign-in in Magpie.
- At the bottom, today's schedule (「今日定时」) shows each slot's result and the next run; the alerts (「需要你留意」) list credits lapsing within 10 days, enterprise allowance resets, tasks to do by hand, and accounts that failed to read or whose login is about to expire.
- Each personal account shows today's daily check-in: for China, Magpie's record (checked in +100, not yet, needs the WorkBuddy client…), with a switched-off or missed check-in in the alerts; for WorkBuddy AI, this plugin's own result, or 「暂无签到活动」 (no campaign) while none runs. Enterprise accounts have no daily check-in credits and show none. WorkBuddy AI accounts are tagged 「国际版」 in the list.
- Enterprise accounts show their monthly allowance, usage and reset time.

**Entry points**

- Magpie's sidebar page: the board, recent runs, and buttons to add an account, send Buddies travelling, refresh, run everything, and pause or start schedules.
- The local panel at http://127.0.0.1:3439: the same board, plus running selected accounts, the last 100 runs, and editing schedules and the proxy.
- Add account (「添加账号」) runs Magpie's own `magpie plugin login workbuddy`, which opens the official browser sign-in; signing in to an account again replaces its old login. This plugin never touches login tokens and offers no account file import or export.

> [!IMPORTANT]
> Growth tasks include simulated client event reports; they don't mean the action was really done in the desktop client. Whether they count, pay out, or get an account restricted is up to WorkBuddy, and not every task can be completed. Following the official account, real donations and some desktop actions need you; tasks already reached can still be claimed.

## Default schedule

All times are `Asia/Shanghai` and can be changed in the panel; clearing a kind's times turns that kind off.

| Time | Action |
| --- | --- |
| 01:00 | China night-owl task |
| 09:00, 21:00 | Activity, Buddy travel, streak rewards (plus the check-in on WorkBuddy AI) |
| 09:10, 21:10 | Growth tasks |
| 22:00 | Login renewal check, renewing two hours ahead |

Each slot runs at a random moment around its set time (±10 minutes by default, different every day and on every computer; the night-owl task stays inside 23:00–08:00), and a scheduled run waits a random 5–45 seconds between accounts, so not everyone reaches WorkBuddy on the hour. Change it with 「随机错开」 under the panel's settings; 0 turns it off. The board's 「今日定时」 shows when each slot runs today. Schedules are checked every 30 seconds. A failure is retried at least 15 minutes later, up to 3 tries per slot. When WorkBuddy rate-limits (HTTP 429) the run first waits and retries; a run still limited is marked "retry later" (「稍后重试」) rather than failed, and is retried on the same spacing. Each kind takes up to 24 times. Streak activity doesn't repeat once it succeeded that day; travel and task rewards are checked against WorkBuddy's state. China's daily check-in follows Magpie's own setting and is not one of this plugin's schedules; WorkBuddy AI's check-in runs in the activity, travel and streak-rewards slots.

## Tools and terminal

The plugin's card under Plugins → Installed shows its tool names and lets you copy Magpie's MCP address.

| Tool | Use |
| --- | --- |
| `status` | China accounts, runs and schedule settings |
| `run` | Start an action; `all` covers activity, growth tasks, travel and streak rewards |
| `schedules` | Show or switch schedules; times are edited in the web panel |
| `board` | The account board: credits, package lapse dates, 7-day usage, travel and streak |

In the source or install folder you can also use the terminal:

```sh
bun cli.mjs status
bun cli.mjs run all
bun cli.mjs board
bun cli.mjs pause
bun cli.mjs resume
```

`run` also takes `activity`, `tasks`, `travel`, `bonus`, `night`, `keepalive` and `inspect`. Each returns a run id; check the result in the panel or with `status`.

<details>
<summary><b>How the Magpie page works</b></summary>

Magpie runs plugin pages in a sandbox with no network, so the page reads `page/data.js`, which the service writes (balances, usage and travel only, no credentials), and reloads it every 15 seconds; after a plugin update an open page loads the new version by itself. The page's buttons submit requests by saving them into the plugin's options, which makes Magpie reload the plugin once and hand the request to the service; each request runs once, and one older than 10 minutes is refused. The page says so when its data is more than 25 minutes old.

</details>

## Settings and data

| Location | Contents |
| --- | --- |
| `~/.config/workbuddy-plus/config.json` | Schedules, the random offset in minutes (`spread`), account switches, the WorkBuddy AI switch (`intl`) and HTTP proxy |
| `~/.config/workbuddy-plus/state.json` | Run history and de-duplication state |
| `~/.config/workbuddy-plus/service.log` | Service log |
| `page/data.js` in the plugin folder | The board snapshot for Magpie's page, rewritten by the service |
| `~/Library/LaunchAgents/io.github.sabercomo.magpie-workbuddy-plus.plist` | macOS background start (optional install) |

China logins are read from `~/.config/magpie/plugin-auth.json`. When Magpie uses a custom config folder, `XDG_CONFIG_HOME` is followed, or point `WORKBUDDY_PLUS_MAGPIE_DIR` at it; `WORKBUDDY_PLUS_DIR` sets this plugin's data folder.

**Port**: the service listens on `127.0.0.1:3439`. When it runs from Magpie, change it with the plugin option:

```sh
magpie plugin options <plugin name> '{"port":4389}'
```

The plugin name is the one `magpie plugin list` shows. When you start the service without Magpie, use the `WORKBUDDY_PLUS_PORT` environment variable; the macOS background install reads it when you run `bun install.mjs`, so to change the port later, install again with the new value and keep the plugin option on the same port. A port taken by another program or reserved by the system doesn't make the service wait: it writes the reason and exits. Only when a WorkBuddy Plus is already running on that port does a new service wait to take over.

<details>
<summary><b>What the board reads</b></summary>

The board only reads `get-user-resource` (credit packages; `get-enterprise-user-usage` for an enterprise account's monthly allowance), `get-user-request-usage` (official usage: credits, requests and models, plus the time, credit, model and client of the 50 most recent charged requests as the deductions list; request contents are not kept) and the growth center's tasks, energy, Buddy collection, draw count, travel and streak state. It claims or spends nothing. Enterprise accounts show only their allowance and usage. China's daily check-in result is read from Magpie's own `plugin-checkin.json` and its switch; this plugin never calls China's check-in endpoint. For WorkBuddy AI it reads `checkin-activity-status` and calls `daily-checkin` when a campaign runs and today isn't claimed yet.

The Models view reads both builds' `/v3/config` (the WorkBuddy client's own model config: models, multipliers, the Pro Only and subscriber-priority tiers, promotions) and `get-user-resource-summary` (the account's plan). It calls no model and spends no credits. The China list is read with the first personal account; the WorkBuddy AI list only with the `workbuddy-ai` account signed in to Magpie.

The plugin works with Magpie through its local account file, renewing logins under the same file and account locks Magpie uses. A change in Magpie's storage format may need an update here. Released source contains no personal account files, settings or run history.

The service listens on `127.0.0.1` only. An HTTP proxy can be set in the panel; proxied requests need Bun. Node.js 22+ can run the tests, or the service without a proxy.

</details>

## Updating and stopping

Installed from Magpie: run `magpie plugin update`. If you installed a pinned version (`magpie plugin list` shows a suffix like `#v0.4.0`), remove it with `magpie plugin rm` and `magpie plugin add` the unpinned address again; plugin options such as the port need setting again. A service already running keeps the old code: end it (or log out, or restart) and Magpie starts the new version the next time it loads the plugin.

The macOS background install: update the source folder and install again; settings and history are kept.

```sh
git pull --ff-only
bun install.mjs
```

Turning the plugin off in Magpie only turns off its tools. **To stop automatic tasks, click 「暂停定时」 (pause schedules) in the panel first**, or run `bun cli.mjs pause`.

<details>
<summary><b>Removing the macOS background install completely</b></summary>

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.github.sabercomo.magpie-workbuddy-plus.plist"
magpie plugin rm "$HOME/Applications/Magpie-WorkBuddy-Plus"
```

Then delete the install folder and the plist above. Settings and history in `~/.config/workbuddy-plus` can stay. If you also installed the plugin by its repository address, remove that entry from Magpie's installed list too.

</details>

## Development

No npm dependencies to install. Tests use mock accounts and a mock upstream, and never touch a personal account or a real reward endpoint.

```sh
npm test
```

The tests cover China and WorkBuddy AI account selection and the WorkBuddy AI switch, WorkBuddy AI tasks and check-in, credentials kept out of status replies, run-all never calling the daily check-in, growth task progress, travel rewards, package merging and lapse dates, task categories, usage paging and deductions, board snapshots without credentials, page request de-duplication, rate-limit retries, the add-account flow, login renewal races, schedule de-duplication, the panel and the local HTTP boundary, the model catalog, and the service port.

The README screenshots are taken in Magpie after `docs/demo-data.mjs` writes made-up accounts.

The repository carries the `magpie-plugin` GitHub topic so Magpie's unofficial Discover section can find it; that doesn't mean Magpie's maintainers reviewed or recommend it.

## License and credits

MIT. Credit package merging and usage paging are adapted from [zseeu1/wbkit](https://github.com/zseeu1/wbkit) (MIT); reading the enterprise allowance follows Magpie's WorkBuddy plugin. Where the task codes, endpoints and login fields come from, and their licenses, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
