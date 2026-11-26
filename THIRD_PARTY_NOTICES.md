# Third-party sources

This project includes adaptations of these MIT-licensed projects:

- [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub), revision `a6a967ef04b9824e962c4f285ebd589fbb1f1312`: growth-task codes and event shapes, Buddy travel/streak APIs, check-in result handling and the skill market/share-channel calls (`wb_tasks.py`, `wb_accounts.py`; adapted in `events.mjs` and `skills.mjs`). Copyright (c) 2026.
- [M-strange/workbuddy2api-hub](https://github.com/M-strange/workbuddy2api-hub), revision `b1437c23272810c3e2ba21e82669ba74153ebd30`: the Buddy blind-box quota/open flow (`do_buddy_open` in `wb_tasks.py`), dynamic expert resolution from a task's `jump_url` (`extract_expert_from_task`), and the upstream/Magpie check-in later-record rule (`checkin_today_of` in `wb_proxy.py`), plus its 20-second task-list cache/invalidation and 6-hour persisted progress-cache concepts (`wb_proxy.py`; adapted in `engine.mjs`, `events.mjs`, `board.mjs`, `client.mjs` and `runner.mjs`; the long cache here is display-only on failed reads). MIT licensed.
  The same revision's `_parse_package_account` in `wb_accounts.py` informed the `AccountAttributes` / `grantReason` extraction in `board.mjs`.
- [jichie/magpie-workbuddy-tasks](https://github.com/jichie/magpie-workbuddy-tasks), revision `0474b8c9105cba4bf341dbfd2b9c8c08fa240b17`: the Buddy blind-box quota/open flow, travel-state checks and default-off scheduling (`engine/buddy.mjs`; adapted in `engine.mjs` and `board.mjs`). MIT licensed.
- [zseeu1/wbkit](https://github.com/zseeu1/wbkit), revision `eb0f0e7c74cf450e3977731f33781dc1a889b583`: credit-package merging and expiry handling (`lib/quota.mjs`), usage paging past the 3000-row cap (`lib/usage.mjs`), and the layout of the package and Buddy travel cards (adapted in `board.mjs` and `page/board.js`). Copyright (c) 2026 zseeu1.
- [magpie-community/plugins](https://github.com/magpie-community/plugins), revision `f96891787552f3c68c850c68057ad21d274626c2`: WorkBuddy headers from `packages/workbuddy/index.mjs`, and reading an enterprise account's monthly allowance from `/billing/meter/get-enterprise-user-usage` (`enterpriseUsageOf`, adapted in `board.mjs`).
- [misakano7545/workbuddy2api-panel](https://github.com/misakano7545/workbuddy2api-panel), revision `2b210e9`: the desktop, web and mini-program report channels (hosts, headers and the fields stamped on each event), the event sequences for `RichMeow_Chat`, `Buddy_App`, `Buddy_App_QQ` and `Library_read`, the mini program's task list, accept, report and claim, the claim-only task sweep, and the campaign portal and skill-share action flow (`internal/upstream/desktop.go`, `mp_events.go`, `tasks.go`, `internal/panel/autotask.go`, `tasksweep.go`; adapted in `events.mjs`, `engine.mjs`, `campaign.mjs` and `skills.mjs`). Copyright (c) its authors.
- [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel), revision `73a7560efc7a88ebd9865db4c71ae7f6d85859f8`: the official compensation status query and its active/claimed/credit/end semantics (`internal/upstream/compensation.go`; adapted in `engine.mjs`, `board.mjs` and `page/board.js`). MIT licensed.
- [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily), revision `6f7d65e1f25bc1899e7c8a42740ebb222c3f67a8`: the event shapes for `Sequential_Tasks_4` to `7`, the App campaign's `/v2/as/conversations/` plus ACP `bootstrap` conversation flow, and the physical-prize type in draw responses (`workbuddy_daily.py`; adapted in `events.mjs`, `campaign.mjs` and `engine.mjs`). MIT licensed.
- [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin), revision `4ee159f0e4d1472f51135b9d72519a191c88fdec`: the `need_address` and `require_address` prize flags (`signin.py`; adapted in `engine.mjs`). MIT licensed.
- [NotoChen/magpie-workbuddy-sync](https://github.com/NotoChen/magpie-workbuddy-sync), revision `a4ce7c516cbcb76e2172dbcd9edaf508c06945bf`: the original `magpie-data` encryption module and adapted GitHub Contents client, URL parser, locks, auth-file merge, master lease and per-follower heartbeat logic in `sync/`. The original MIT notice is in `sync/LICENSE`. Plus uses a separate path and projects OAuth entries to access-only before encryption.
- [yetone/magpie](https://github.com/yetone/magpie), revision `e71c54647c7df9206432ef93ed61f2f0abf51607`: active `sync.json` configuration conventions and WebDAV/S3 endpoint and write semantics in `internal/davsync`, used as a reference for `sync/config.mjs` and `sync/object-store.mjs`. Plus does not use Magpie's unconditional write fallback.
- [mhart/aws4fetch](https://github.com/mhart/aws4fetch), npm release `1.0.20`: unmodified ESM distribution in `sync/vendor/aws4fetch.mjs` for S3 SigV4. MIT notice retained in `sync/vendor/aws4fetch.LICENSE`.
- [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily/commit/68cbb256d95163ab939040f97114a8e764f2ff24), revision `68cbb256d95163ab939040f97114a8e764f2ff24`: skill-share channel receipt validation and the desktop event keyed by channel ID (`workbuddy_daily.py`, adapted in `skills.mjs`). MIT licensed.
- [misakano7545/workbuddy2api-panel](https://github.com/misakano7545/workbuddy2api-panel/commit/d3edea903e0eaf0625c7689642cefc6ae7a50eb1), revision `d3edea903e0eaf0625c7689642cefc6ae7a50eb1`: the distinction between account-level `11140` restrictions and model/provider refusals (`internal/upstream/restrict.go`, reflected in `client.mjs`). MIT licensed.

Magpie's local `plugin-auth.json` layout was checked against [yetone/magpie](https://github.com/yetone/magpie), `internal/plugin/host.js` and `store.go`. This companion does not include Magpie's gateway or replace its WorkBuddy provider.

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
