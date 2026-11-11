// Event shapes and task IDs ported from workbuddy2api-hub/wb_tasks.py (MIT).
// The desktop, web and mini-program reports (the tasks marked `via`) follow
// workbuddy2api-panel (MIT): internal/upstream/desktop.go and mp_events.go.
// See THIRD_PARTY_NOTICES.md for the pinned upstream revisions.
import { createHash, randomUUID } from "node:crypto";

export const specs = {
  first_buddy: { kind: "chat" }, create_canvas: { kind: "canvas" }, template_5: { kind: "template" },
  expert_5: { kind: "expert" }, Expert_team_use_3: { kind: "team" }, skill_1: { kind: "skill" },
  automation_1: { kind: "automation" }, playbook_prompt: { kind: "playbook" }, Expert_lighthouse: { kind: "lighthouse" },
  Hp_Appearance: { kind: "skin" }, chat_5: { kind: "chat" }, "Model_chat_GLM5.2": { kind: "glmchat" },
  black_cat: { kind: "cat", night: true }, WorkBuddy_Valorant: { kind: "expert", expert: ["ex_xQHHD1u5Jkua", "无畏契约拼豆专家"] },
  // These four are present in the live 2026-10-29 task list; IDs come from
  // each task's own official jump_url, rather than another expert's event.
  expert_use_maidehao: { kind: "expert", expert: ["ex_GDl31WahyIH0", "中国电商运营专家"] },
  expert_use_douyinyin: { kind: "expert", expert: ["ex_FbY5nlWTqDod", "抖音策略师"] },
  expert_use_shangjia_xuanchuan: { kind: "expert", expert: ["ex_Weo3x2EZuSDm", "商家宣传页与海报设计师"] },
  expert_use_bowangwang: { kind: "expert", expert: ["ex_WZY136wV5aMt", "直播电商教练"] },
  // Counted only from the desktop client's own reports: a whole chat as it
  // logs one, and the five steps of entering a Buddy app (企鹅教师助手, which
  // lights both tasks).
  RichMeow_Chat: { kind: "deskchat", via: "desktop" },
  Buddy_App: { kind: "buddyapp", via: "desktop" }, Buddy_App_QQ: { kind: "buddyapp", via: "desktop" },
  // A click on the library's introduction, as the web app reports it.
  Library_read: { kind: "library", via: "web" },
  // The mini program's own tasks, listed only to a mini-program client. Its
  // chats must come at a person's pace: a burst is counted, then rolled back.
  Sequential_Tasks_1: { kind: "minichat", via: "mp", target: 1, pace: 45_000 },
  Sequential_Tasks_2: { kind: "miniexpert", via: "mp", target: 1 },
  Sequential_Tasks_3: { kind: "minichat", via: "mp", target: 5, pace: 45_000 }
};

// Tasks that need a person and are neither listed nor counted. Any other task
// nothing here does yet still shows, as one to do by hand, so a new one
// is seen the day it appears.
export const unreachable = new Set(["wb_wechat_oa_subscribe_task", "Expert_Philanthropy", "skill_share"]);

// What a mini-program client sends to see, accept and claim its own tasks.
export const miniProgram = { "X-Client-Platform": "miniprogram" };

// WorkBuddy AI's growth tasks are a level ladder (code and status, no
// progress or reward) counted from real use of its client; they read here in
// China's shape, as tasks for a person to do until the server marks them done.
export function growthTasks(list) {
  return list.map(t => t.task_code !== undefined ? t : {
    task_code: t.code, title: t.title, intl: true, note: "按 WorkBuddy AI 客户端里的实际使用计入",
    accept_status: { completed: "completed", claimable: "completed", claimed: "claimed" }[t.status] || "accepted"
  });
}

const experts = [
  ["ex_PZw8Gu81HfN4", "运维工程师"], ["ex_ROsDtJbzADFV", "产品经理"],
  ["ex_SMUnl0nJbPix", "UI设计师"], ["ex_ZTR062oVBOCW", "数据分析师"], ["ex_a3sSSFBy8qaC", "后端架构师"]
];
const teams = [["CloudOpsTeam", "运维专家团队"], ["CloudContentTeam", "内容专家团队"], ["CloudDevTeam", "研发专家团队"]];

// A device id that stays the same for an account, as one machine would.
const device = (uid, salt, length = 36) => createHash("sha256").update(`${salt}:${uid}`).digest("hex").slice(0, length);
const hex = () => randomUUID().replaceAll("-", "");

// Where a kind of client reports and what it says about itself: the host, the
// request's headers, and the fields stamped on each of its events.
export function channel(via, account) {
  const a = account.auth, now = Date.now(), name = account.name || "";
  const auth = { Authorization: `Bearer ${a.access}`, "X-User-Id": a.uid };
  const node = { ...auth, Accept: "application/json, text/plain, */*", "Content-Type": "application/json;charset=UTF-8", "X-Product": "SaaS", "X-Request-ID": hex() };
  if (via === "desktop") return {
    base: "https://copilot.tencent.com",
    headers: { ...node, "User-Agent": "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0", "X-Domain": "copilot.tencent.com" },
    stamp: {
      timezone: "Asia/Shanghai", reportDelay: 2000, userId: a.uid, username: name, userNickname: name, product: "SaaS",
      releaseDate: 1793093056315, commit: "d46924219e79332f49c37ccebf27292f87001b19", ideName: "WorkBuddy", ideType: "WorkBuddy", ideVersion: "5.9.3",
      machineId: device(a.uid, "machine"), sessionId: device(a.uid, "session"), extName: "workbuddy-desktop", extVersion: "5.9.3",
      os: "win32", arch: "x64", osVersion: "10.0.28000", cpuModel: "11th Gen Intel(R) Core(TM) i5-11320H @ 3.20GHz", cpuCores: 8, memorySize: 16,
      timestamp: now, presentAt: now, qimei36: device(a.uid, "qimei")
    }
  };
  if (via === "web") {
    const agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    return {
      base: "https://www.workbuddy.cn", headers: { ...node, "User-Agent": agent, "X-Domain": "www.workbuddy.cn" },
      stamp: { timestamp: now, reportDelay: 0, os: "Win32", arch: "", osVersion: "10.0", userAgent: agent, machineId: device(a.uid, "webmachine"), userId: a.uid, userNickname: name, enterpriseId: a.enterpriseId || "" }
    };
  }
  if (via === "mp") {
    const m = device(a.uid, "mp", 32);
    return {
      base: "https://www.codebuddy.cn",
      headers: { ...auth, "Content-Type": "application/json", Accept: "application/json", "X-Client-Product": "workbuddy-mp", "X-Client-Version": "2.4.0", "X-Client-Platform": "mp-weixin", "X-Platform": "wechatmp" },
      stamp: {
        timestamp: now, ideType: "WorkBuddy_MP", ideVersion: "2.4.0", extName: "workbuddy-mp", extVersion: "2.4.0", product: "SaaS", ideName: "wx_app_cloud", platform: "mini_program",
        os: "windows", osVersion: "11", arch: "x64", machineId: `${m.slice(0, 8)}-${m.slice(8, 12)}-4${m.slice(13, 16)}-a${m.slice(17, 20)}-${m.slice(20, 32)}`,
        timezone: "Asia/Shanghai", userId: a.uid, userNickname: name
      }
    };
  }
  return null;
}

// One unit of a task's progress as the events that make it up. Most tasks
// are one event from the CLI; the desktop's are a short run of them.
export function buildEvents(account, spec, index = 0) {
  const conversationId = randomUUID(), requestId = hex(), messageId = hex();
  const agent = { traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId, agentName: "cli", agentType: "main" };
  const session = { "codebuddy.session_id": conversationId, "codebuddy.conversation_request_id": requestId };
  const tokens = { inputToken: 120, outputToken: 80, totalToken: 200, cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0, isSuccessful: true, messageErrorCode: "", finishReason: "stop" };
  const send = { inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0, mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: "", mentionContextCount: 0, command: "", recommendId: "", skillId: "", skillCount: 0, totalCount: 0 };
  switch (spec.kind) {
    case "deskchat": return [
      { eventCode: "agent_task_created", source: "LOCAL", name: "working", task_target: "local", mode: "craft", requestModelId: "fast-model", requestModelName: "fast-model",
        has_repo: false, repo_type: "none", workspace_type: "empty", has_connector: false, connector_types: [], has_mention: false, mention_types: [], has_template: false, action: "", template_name: "",
        has_expert: false, expert_id: "", expert_name: "", expert_industry_id: "", has_skill: false, skill_names: [], conversationId, messageId, buddyId: "", buddyName: "" },
      { eventCode: "chat_message_send", messageId: `${messageId}-assistant`, historyCount: 0, isContextTruncated: false, currentStepCount: 1, ...agent },
      { eventCode: "chat_request_send", ...send, ...agent, ...session },
      { eventCode: "chat_message_response", messageId: `${messageId}-assistant`, responseModelId: "fast-model", ...tokens, firstTokenAt: Date.now(), conversationId, ...agent, ...session },
      { eventCode: "chat_message_status", messageId: `${messageId}-assistant`, messageErrorCode: "0", ...agent },
      { eventCode: "chat_request_response", mode: "craft", toolCallCount: 0, ...tokens, rootRequestId: requestId, parentConversationId: conversationId }
    ];
    case "buddyapp": {
      const app = { mode: "LOCAL", buddyId: "cb_y5Dy46tPQGGWtueMxXbe", buddyName: "企鹅教师助手" }, element = { elementId: app.buddyId, elementName: app.buddyName };
      return [
        { eventCode: "buddyapp_discover_click", ...app }, { eventCode: "buddyapp_show", ...app, ...element, position: 2 },
        { eventCode: "buddyapp_enter_click", ...app, ...element, position: 2, isFirstPage: "1" },
        { eventCode: "buddyapp_auth_confirm_click", ...app, ...element }, { eventCode: "buddyapp_bindaccount_skip_click", ...app, ...element }
      ];
    }
    case "library": return [{ eventCode: "web_element_click", pageURL: "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm", elementId: "library_doc_intro_click", elementName: "WorkBuddy资料库介绍" }];
    case "minichat": return [{ eventCode: "chat_request_send", ...send, inputLength: 14, traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId, conversationId, messageId: `msg-${requestId.slice(-8)}`, agentName: "mp", agentType: "main", ...session }];
    // The mini program names the expert by id in both fields; the id must be a real one.
    case "miniexpert": { const [id, name] = experts[index % experts.length]; return [{ eventCode: "expert_actual_use", reportDelay: 0, extVersion: "2.2.8", source: "mini_program", id, name: id, expertTitle: name, type: "send_message", characterCount: 12, expertType: "agent" }]; }
    default: return [buildEvent(account.auth.uid, spec, index)];
  }
}

export function buildEvent(uid, spec, index = 0) {
  const timestamp = Date.now();
  const conversationId = randomUUID();
  const requestId = randomUUID().replaceAll("-", "");
  const base = { timestamp, reportDelay: 0, userId: uid };
  const chat = { ...base, conversationId, requestId };
  switch (spec.kind) {
    case "canvas": return { ...chat, eventCode: "wbx_design_canvas_task_create", source: "summon_keyword", isCustomModel: false, name: "", inputLength: 12, id: `wbx-canvas-${conversationId}`, cost: 0, isSuccessful: true };
    case "template": return { ...chat, eventCode: "agent_task_created_with_template", isCustomModel: true, id: String(index), name: "幻灯片" };
    case "expert":
    case "team":
    case "lighthouse": {
      const pool = spec.kind === "team" ? teams : experts;
      const [id, name] = spec.expert || (spec.kind === "lighthouse" ? ["ex_2cvvUZQhDyeJ", "腾讯轻量云专家"] : pool[index % pool.length]);
      return { ...chat, eventCode: "expert_actual_use", mode: "CLOUD", id, name, expertTitle: name, type: "02-Engineering", expertType: spec.kind === "team" ? "team" : "agent", source: "builtin", version: "1.0.2", cost: 0, characterCount: 12, messageId: requestId, requestModelId: "deepseek-v4-flash", requestModelName: "DeepSeek V4 Flash" };
    }
    case "skill": return { ...base, eventCode: "skill_info", skillId: "skill_2096525080079265792", name: "pptx" };
    case "automation": return { ...chat, eventCode: "automated_task_create_suc", name: "每周工作整理", type: "cron", source: "manually", modelId: "deepseek-v4-flash", modelIsThinking: false, schedule: { type: "recurring", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0" }, prompt: "每周五自动整理本周工作" };
    case "playbook": return { ...chat, eventCode: "playbook_prompt_send", id: "worker-ledger-freedom-dashboard", name: "打工人小账本", type: "other", promptLength: 10, isOfficial: 1, source: "discover" };
    case "skin": return { ...base, eventCode: "appearance_skin_apply", action: "apply", source: "settings_close", id: "theme-tkmw7j", vipLevel: "free", series: "craft", type: "unknown", name: "和平精英激战金秋" };
    case "chat":
    case "glmchat":
    case "cat": {
      const glm = spec.kind !== "chat";
      const [requestModelId, requestModelName] = spec.model || (glm ? ["glm-5.2", "GLM-5.2"] : ["deepseek-v4-flash", "DeepSeek V4 Flash"]);
      return { ...chat, eventCode: "chat_request_send", mode: spec.kind === "cat" ? "night" : "craft", inputLength: 12, requestModelId, requestModelName, isPlan: false, agentName: "default", agentType: "conversation" };
    }
    default: throw new Error(`未知事件类型：${spec.kind}`);
  }
}
