# Third-party sources

This project includes adaptations of these MIT-licensed projects:

- [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub), revision `a6a967ef04b9824e962c4f285ebd589fbb1f1312`: growth-task codes and event shapes, Buddy travel/streak APIs and check-in result handling (`wb_tasks.py`, `wb_accounts.py`). Copyright (c) 2026.
- [zseeu1/wbkit](https://github.com/zseeu1/wbkit), revision `eb0f0e7c74cf450e3977731f33781dc1a889b583`: credit-package merging and expiry handling (`lib/quota.mjs`), usage paging past the 3000-row cap (`lib/usage.mjs`), and the layout of the package and Buddy travel cards (adapted in `board.mjs` and `page/board.js`). Copyright (c) 2026 zseeu1.
- [magpie-community/plugins](https://github.com/magpie-community/plugins), revision `f96891787552f3c68c850c68057ad21d274626c2`: WorkBuddy headers and refresh-token fields from `packages/workbuddy/index.mjs`, and reading an enterprise account's monthly allowance from `/billing/meter/get-enterprise-user-usage` (`enterpriseUsageOf`, adapted in `board.mjs`).

Magpie's local `plugin-auth.json` layout and lock conventions were checked against [yetone/magpie](https://github.com/yetone/magpie), `internal/plugin/host.js` and `store.go`. This companion does not include Magpie's gateway or replace its WorkBuddy provider.

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
