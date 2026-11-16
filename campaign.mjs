// WorkBuddy's operation campaigns live in the mini program's portal, not in
// the growth-task list. Reading and claiming them is one contract; the tasks
// that can be advanced from here are the chat, expert, skill and desktop
// actions the mini program reports. App conversations and friend invites are
// left for a person.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { channel } from "./events.mjs";
import { dropped } from "./network.mjs";

const base = "https://www.codebuddy.cn";
const page = (pageURL, pageName) => ({ pageURL, pageName });
const appBase = "https://copilot.tencent.com";
const appPrompt = '你只需要回复"Hi"';
const appBoxDomains = ["tencent.com", "codebuddy.cn", "workbuddy.cn", "workbuddy.agentos-worker.net"];

const campaigns = [
  {
    code: "campaign_starbucks_2026", label: "星巴克协作",
    page: page("subpackages/secondary/starbucks-activity-428/index", "starbucks_activity"),
    tasks: [
      { code: "ai_chat", label: "与 AI 对话 3 次", kind: "chat", times: 3, credit: 100 },
      { code: "expert", label: "召唤专家并对话", kind: "expert", credit: 100 },
      { code: "app", label: "解锁 App 强大能力", kind: "app", credit: 100 },
      { code: "invite", label: "邀请好友", kind: "invite", credit: 0 }
    ]
  },
  {
    code: "campaign_reporter_2026", label: "记者节福利活动",
    page: page("subpackages/journalist-benefit/index", "journalist_benefit"),
    tasks: [
      { code: "expert_chat", label: "体验「媒体工作助理」专家", kind: "expert", expertId: "ex_NaiDbO06Adf3", expertName: "媒体工作助理", credit: 50 },
      { code: "skill_use", label: "体验「采访素材整理」技能", kind: "skill", skillId: "skill_2117491159283752960", skillName: "interview-material-organizer", credit: 50 },
      { code: "desktop_same", label: "体验「内容发布排期」灵感", kind: "desktop", credit: 100 }
    ]
  }
];

const headers = client => () => channel("mp", client.account).headers;
const call = (client, path, body) => client.request(path, {
  base, headers: headers(client), ...(body === undefined ? {} : { body })
});

async function readTasks(client, campaign) {
  const query = `activity_code=${encodeURIComponent(campaign.code)}`;
  const data = await call(client, `/portal/activity/tasks?${query}`);
  const progress = new Map((data?.progress || []).map(p => [p.task_code, p]));
  return {
    rows: new Map((data?.tasks || []).map(t => [t.task_code, {
      target: t.target_count || 1,
      credit: t.reward_credit || 0,
      needView: t.need_view !== false,
      ...progress.get(t.task_code)
    }]))
  };
}

const done = row => !!row?.completed_at || (row?.progress || 0) >= (row?.target || 1);

async function claim(client, campaign, code, credit) {
  await call(client, `/portal/activity/tasks/${encodeURIComponent(code)}/claim?activity_code=${encodeURIComponent(campaign.code)}`, {});
  return credit;
}

async function viewed(client, campaign, code) {
  await call(client, `/portal/activity/tasks/${encodeURIComponent(code)}/viewed?activity_code=${encodeURIComponent(campaign.code)}`, {});
}

async function poll(client, campaign, code, target, { sleep, poll, tries = 5 }) {
  let row = {};
  for (let attempt = 0; attempt < tries; attempt++) {
    await sleep(poll);
    row = (await readTasks(client, campaign)).rows.get(code) || {};
    if (row.completed_at || (row.progress || 0) >= target) break;
  }
  return row;
}

const chatEvent = page => {
  const conversationId = randomUUID(), requestId = randomUUID().replaceAll("-", "");
  return {
    ...page, eventCode: "chat_request_send", mode: "chat", inputLength: 12, isPlan: false,
    isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false, maxToken: 0,
    maxSteps: 500, temperature: 0, maxRetries: 0, mentionContexts: [], knowledgeId: [],
    knowledgeName: [], codebaseId: "", mentionContextCount: 0, command: "", recommendId: "",
    skillId: "", skillCount: 0, totalCount: 0, conversationId, requestId,
    traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
    messageId: `msg-${requestId.slice(-8)}`, agentName: "mp", agentType: "main",
    "codebuddy.session_id": conversationId, "codebuddy.conversation_request_id": requestId
  };
};

const expertEvents = (page, id, name) => {
  const conversationId = randomUUID(), requestId = randomUUID().replaceAll("-", "");
  const common = { ...page, id, name, expertTitle: name };
  return [
    { ...common, eventCode: "expert_summon_click", type: "16-BackToSchool", position: 0 },
    { ...common, eventCode: "expert_summoned" },
    { ...common, eventCode: "expert_actual_use", type: "16-BackToSchool", characterCount: 14, expertType: "builtin" },
    { ...page, eventCode: "chat_request_send", inputLength: 14, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
      codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0, mentionContexts: [],
      knowledgeId: [], knowledgeName: [], codebaseId: "", mentionContextCount: 0, command: "", recommendId: "",
      skillId: "", skillCount: 0, totalCount: 0, conversationId, requestId, expertId: id, expertName: name,
      "codebuddy.session_id": conversationId, "codebuddy.conversation_request_id": requestId }
  ];
};

const skillEvents = (page, id, name) => {
  const conversationId = randomUUID(), requestId = randomUUID().replaceAll("-", "");
  return [
    { ...page, eventCode: "skill_info", id: name, skillId: id, skillName: name, skillType: "market", skillSource: "market", position: 0, conversationId },
    { ...page, eventCode: "chat_request_send", inputLength: 14, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
      codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0, mentionContexts: [],
      knowledgeId: [], knowledgeName: [], codebaseId: "", mentionContextCount: 0, command: "", recommendId: "",
      skillId: id, skillCount: 1, totalCount: 0, conversationId, requestId, agentName: "mp", agentType: "main",
      "codebuddy.session_id": conversationId, "codebuddy.conversation_request_id": requestId }
  ];
};

const desktopEvent = () => ({
  eventCode: "playbook_prompt_send", id: "cnb-content-calendar", name: "内容发布排期表",
  type: "table", promptLength: 359, isOfficial: 1, source: "discover", query: "", ext1: "discover",
  requestId: randomUUID().replaceAll("-", ""), conversationId: randomUUID()
});

const appHeaders = (token, uid, accept = "application/json") => ({
  Authorization: `Bearer ${token}`, "X-User-Id": uid, "User-Agent": "WorkBuddyApp/2.8.0", "Content-Type": "application/json",
  "X-Client-Version": "2.8.0", "X-Client-Product": "workbuddy-app", "X-Client-Platform": "android", Accept: accept
});

const appBox = raw => {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) return null;
  if (!appBoxDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;
  return url.href.replace(/\/+$/, "");
};

const appMachine = uid => createHash("sha1").update(`workbuddy-app-machine:${uid}`).digest("hex").slice(0, 8);

// The app task counts a finished cloud App conversation, not a report event.
// Create the App conversation, then let the sandbox run one ACP turn to end_turn.
async function appChat(client) {
  const uid = client.account.auth.uid;
  let created;
  try {
    created = await client.request("/v2/as/conversations/", {
      base: appBase, headers: () => appHeaders(client.account.auth.access, uid),
      body: { name: "开始新对话", conversationOrigin: "agents" }
    });
  } catch (e) { throw new Error(`App 建会话失败：${e.message}`); }
  const session = created?.session;
  if (!session?.boxUrl || !session?.token) throw new Error("App 建会话响应缺少 boxUrl 或 token");
  const box = appBox(session.boxUrl);
  if (!box) throw new Error("App 建会话返回了不受信任的 boxUrl");

  const info = { ideType: "WorkBuddy_APP", ideName: "app_cloud", ideVersion: "2.8.0", extName: "WorkBuddy_APP", extVersion: "2.8.0", machineId: appMachine(uid), userId: uid };
  const meta = { "codebuddy.ai": { telemetryClientInfo: info } };
  const span = randomUUID().replaceAll("-", "").slice(0, 16);
  const body = {
    initialize: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "WorkBuddyApp", version: "2.8.0" } } },
    sessionNew: { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/workspace", mcpServers: [], _meta: meta } },
    prompt: { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { prompt: [{ type: "text", text: appPrompt }], _meta: meta } }
  };
  const headers = {
    ...appHeaders(session.token, uid, "application/json, text/event-stream"),
    "Content-Type": "application/json",
    "X-Span-Id": span,
    "X-Client-Request-Id": `sse_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    Traceparent: `00-${randomUUID().replaceAll("-", "")}-${span}-01`
  };
  let response;
  try {
    response = await client.fetch(`${box}/acp/bootstrap?includeUserEcho=true`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error" }, 120_000);
  } catch (e) { throw new Error(`App ACP bootstrap 失败：${e.message}`); }
  if (!response.ok || !response.headers.get("Acp-Connection-Id")) throw new Error(`App ACP bootstrap 失败：HTTP ${response.status}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let stream = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    stream += decoder.decode(value, { stream: true });
    if (/"stopReason"\s*:\s*"end_turn"/.test(stream)) {
      await reader.cancel();
      return;
    }
  }
  stream += decoder.decode();
  throw new Error("App 会话没有跑到 end_turn");
}

async function fire(client, campaign, task, row, options) {
  if (task.kind === "chat") {
    for (;;) {
      const before = row.progress || 0;
      if (before >= row.target) return row;
      await client.report([chatEvent(campaign.page)], "mp");
      row = await poll(client, campaign, task.code, row.target, options);
      if (done(row) || (row.progress || 0) <= before) return row;
    }
  }
  if (task.kind === "expert") {
    await client.report(expertEvents(campaign.page, task.expertId || "WorkspaceBuilder", task.expertName || "工作台搭建师"), "mp");
    return poll(client, campaign, task.code, row.target, options);
  }
  if (task.kind === "skill") {
    await client.report(skillEvents(campaign.page, task.skillId, task.skillName), "mp");
    return poll(client, campaign, task.code, row.target, options);
  }
  if (task.kind === "desktop") {
    await client.report([desktopEvent()], "desktop");
    return poll(client, campaign, task.code, row.target, options);
  }
  if (task.kind === "app") {
    await appChat(client);
    return poll(client, campaign, task.code, row.target, { ...options, tries: 6, poll: Math.max(options.poll, 5000) });
  }
  return row;
}

export async function campaign(client, { execute = true, poll: gap = 3000, sleep = delay } = {}) {
  let tasks = 0, ready = 0, claimed = 0, earned = 0, manual = 0, skipped = 0, pending = 0;
  const errors = [];
  const take = async (spec, task, credit) => {
    try { await claim(client, spec, task.code, credit); claimed++; earned += credit; }
    catch (e) {
      if (e.restricted || dropped(e)) throw e;
      if (e.code !== 12304) errors.push(`${spec.label}/${task.label}：${e.message}`);
    }
  };
  for (const spec of campaigns) {
    try {
      const config = await call(client, `/portal/activity/config?activity_code=${encodeURIComponent(spec.code)}`);
      if (config?.config?.in_period !== true) { skipped++; continue; }
      const current = await readTasks(client, spec);
      if (!current.rows.size) { skipped++; continue; }
      tasks += current.rows.size;
      for (const task of spec.tasks) {
        const row = current.rows.get(task.code);
        if (!row) continue;
        const target = row.target || task.times || 1;
        const credit = row.credit || task.credit || 0;
        if (row.claimed_at) continue;
        if (done(row)) {
          if (row.needView) {
            try { await viewed(client, spec, task.code); }
            catch (e) { if (e.restricted || dropped(e)) throw e; errors.push(`${spec.label}/${task.label}：查看失败 ${e.message}`); continue; }
          }
          ready++;
          await take(spec, task, credit);
          continue;
        }
        if (!execute) continue;
        if (!["chat", "expert", "skill", "desktop", "app"].includes(task.kind)) { manual++; continue; }
        if (row.needView) {
          try { await viewed(client, spec, task.code); }
          catch (e) { if (e.restricted || dropped(e)) throw e; errors.push(`${spec.label}/${task.label}：查看失败 ${e.message}`); continue; }
        }
        let after;
        try { after = await fire(client, spec, { ...task, target }, row, { poll: gap, sleep }); }
        catch (e) { if (e.restricted || dropped(e)) throw e; errors.push(`${spec.label}/${task.label}：${e.message}`); continue; }
        if (done(after)) {
          ready++;
          await take(spec, task, credit);
        } else {
          pending++;
        }
      }
    } catch (e) {
      if (e.restricted || dropped(e)) throw e;
      errors.push(`${spec.label}：${e.message}`);
    }
  }
  return { tasks, ready, claimed, earned, manual, skipped, pending, errors };
}

// Read-only campaign progress for the account board. The same portal contract
// is used, but nothing is viewed, reported or claimed here.
export async function campaignStatus(client) {
  const found = [];
  for (const spec of campaigns) {
    try {
      const config = await call(client, `/portal/activity/config?activity_code=${encodeURIComponent(spec.code)}`);
      if (config?.config?.in_period !== true) continue;
      const current = await readTasks(client, spec);
      found.push({
        code: spec.code,
        label: spec.label,
        tasks: spec.tasks.filter(task => current.rows.has(task.code)).map(task => {
          const row = current.rows.get(task.code);
          return {
            code: task.code, label: task.label, progress: row.progress || 0, target: row.target || task.times || 1,
            credit: row.credit || task.credit || 0, done: done(row), claimed: !!row.claimed_at,
            manual: !["chat", "expert", "skill", "desktop", "app"].includes(task.kind)
          };
        })
      });
    } catch (e) {
      if (e.restricted || dropped(e)) throw e;
      found.push({ code: spec.code, label: spec.label, error: e.message });
    }
  }
  return found;
}
