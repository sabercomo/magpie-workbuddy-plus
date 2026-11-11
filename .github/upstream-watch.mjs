import { execFileSync } from "node:child_process";
import { specs, unreachable } from "../events.mjs";

const UPSTREAM = "misakano7545/workbuddy2api-panel";
const SOURCE = "internal/panel/autotask.go";
const LABEL = "upstream-watch";
const MARKER = /<!-- upstream-codes: ?(.*?) -->/;
const repo = process.env.GITHUB_REPOSITORY;

const source = await (await fetch(`https://raw.githubusercontent.com/${UPSTREAM}/main/${SOURCE}`)).text();
if (!source.includes("TaskCode:")) throw new Error(`${SOURCE} 里没有 TaskCode 字段，上游可能改了文件名`);

// 只认任务表里独占一行的 TaskCode；emit(...) 里的 "(批量接受)" 之类是进度标签，不是任务码。
const upstream = [...new Set([...source.matchAll(/^[ \t]*TaskCode:[ \t]*"([^"]+)"/gm)].map((m) => m[1]))].sort();
const local = new Set([...Object.keys(specs), ...unreachable]);
const missing = upstream.filter((code) => !local.has(code));

if (missing.length === 0) {
  console.log("上游任务码都已适配");
  process.exit(0);
}

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

const labels = JSON.parse(gh("label", "list", "--repo", repo, "--limit", "200", "--json", "name"));
if (!labels.some((label) => label.name === LABEL)) {
  gh("label", "create", LABEL, "--repo", repo, "--color", "fbca04", "--description", "上游任务表新增任务码时自动开的问题");
}

const [last] = JSON.parse(gh("issue", "list", "--repo", repo, "--label", LABEL, "--state", "all", "--limit", "20", "--json", "number,state,body"));
const previous = last?.body.match(MARKER)?.[1].split(",").filter(Boolean) ?? [];
const added = missing.filter((code) => !previous.includes(code));
if (last && added.length === 0) {
  console.log("没有新增的上游任务码");
  process.exit(0);
}

const body = `这是自动检查开的 issue，不需要回复。

每天 09:00（上海）对照上游 [workbuddy2api-panel](https://github.com/${UPSTREAM}) 的 [${SOURCE}](https://github.com/${UPSTREAM}/blob/main/${SOURCE})。

下面这些任务码上游已经适配，但本插件的 \`events.mjs\` 里还没有，所以现在会显示「尚未适配此任务」：

${missing.map((code) => `- \`${code}\``).join("\n")}

注意：这只说明上游做了，不代表腾讯刚上线。事件形状要真号实测，确认后再动 \`events.mjs\` 和 \`runner.mjs\`。做完或决定不做，直接关掉这条 issue；任务码没再增加就不会再开。

<!-- upstream-codes: ${missing.join(",")} -->`;

if (last?.state === "OPEN") {
  gh("issue", "update", String(last.number), "--repo", repo, "--body", body);
  console.log(`更新 issue #${last.number}`);
} else {
  console.log(gh("issue", "create", "--repo", repo, "--label", LABEL, "--title", "上游有本插件还没适配的任务", "--body", body));
}
