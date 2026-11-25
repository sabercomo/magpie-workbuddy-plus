# CLAUDE.md

本仓库的完整代理工作规范见 **[AGENTS.md](AGENTS.md)**（架构、红线、Git/测试/收尾与启动清单）；细节以 `AGENTS.md` 为准。

@AGENTS.md

## 红线（违反即返工）

1. **零凭据外泄**：绝不把 `access` / `refresh`、未脱敏代理 URL 或对话原文写入 `page/data.js`、状态响应或日志；不调用国内版每日签到接口。
2. **双版与企业隔离**：国内版与国际版保持独立开关与时段；企业号只接入企业只读看板；`campaignApp` 等真实扣分动作默认关闭。
3. **只读边界**：登录与续期仍由 Magpie 负责。Plus 后台只读 `plugin-auth.json`；只有显式启用的从机同步模块可以更新它自己导入的条目，详见 [AGENTS.md](AGENTS.md) §0。看板保持只读。
4. **安全与沙箱**：本机 HTTP 只绑 `127.0.0.1` + `X-WorkBuddy-Plus: 1` + 严格 CSP；动态 `boxUrl` 须过 `appBox` 白名单；前端禁止不可信 `innerHTML`，`page/index.html` 保存按钮保持 `type="button"`。
5. **先读 `DESIGN.md`、先样稿后发布**：界面/视觉/交互任务动手前先读 `DESIGN.md`，在 `docs/mockups/` 或 `docs/redesign/` 出样稿并待用户同意后再改 `page/` / `public/`；未经用户明确同意，不 `git commit`、不 `git tag`、不发布，也不回复 GitHub Issue（CI 自动修复仅按 `.github/workflows/ai-fix.yml` 开 `--draft` PR，不合并、不改 workflow）。
6. **显式暂存**：禁止 `git add -A` / `git add .`，只暂存本轮涉及路径。

## 会话启动

先按 `AGENTS.md` §5 只读现有 `.project-memory/` 并对照 `git status` / `git log --oneline -15` 校对工作区（设计/UI 任务同时先读 `DESIGN.md`），不初始化或修订归档。存在当前用户任务时读档后直接继续，不据此自动执行旧 TODO；仅用户单独要求「读档」时汇报状态后停止。

## 常用命令（权威：`AGENTS.md` §3.5）

全量测试（提交与发布门禁，与 CI 一致）：

```sh
npm test
```

单文件 / 名称过滤：

```sh
node --test test/storage-runner.test.mjs
node --test --test-name-pattern="handoff" test/storage-runner.test.mjs
```

隔离启动本机服务（避免冲突或污染个人 `~/.config/workbuddy-plus`）：

```sh
WORKBUDDY_PLUS_DIR=/tmp/wb-plus-dev WORKBUDDY_PLUS_PORT=4389 node server.mjs
```

## 迭代收尾（`AGENTS.md` §4）

仅已授权的仓库实施迭代执行：`npm test` 通过 → 同步中英文文档/打包清单并标明「需真号实测」项 →（若用户授权）显式 `git add` 提交 → 执行 `project-save-load` **`存档`** 与 `validate` 校验（`.project-memory/` 保持本地忽略）。

队列并发 1–3，账号内串行；缓存与重试契约见 `AGENTS.md` §3.1。
