// Event shapes and task IDs ported from workbuddy2api-hub/wb_tasks.py (MIT).
// See THIRD_PARTY_NOTICES.md for the pinned upstream revision.
import { randomUUID } from "node:crypto";

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
  expert_use_bowangwang: { kind: "expert", expert: ["ex_WZY136wV5aMt", "直播电商教练"] }
};

export const manualTasks = {
  RichMeow_Chat: "需要在桌面端发起对话", Library_read: "需要在桌面端阅读资料库介绍",
  Buddy_App: "需要在桌面端进入 Buddy 应用", Buddy_App_QQ: "需要在桌面端进入企鹅教师助手",
  wb_wechat_oa_subscribe_task: "需要关注官方公众号满 24 小时", Expert_Philanthropy: "需要实际完成捐赠"
};

const experts = [
  ["ex_PZw8Gu81HfN4", "运维工程师"], ["ex_ROsDtJbzADFV", "产品经理"],
  ["ex_SMUnl0nJbPix", "UI设计师"], ["ex_ZTR062oVBOCW", "数据分析师"], ["ex_a3sSSFBy8qaC", "后端架构师"]
];
const teams = [["CloudOpsTeam", "运维专家团队"], ["CloudContentTeam", "内容专家团队"], ["CloudDevTeam", "研发专家团队"]];

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
      return { ...chat, eventCode: "chat_request_send", mode: spec.kind === "cat" ? "night" : "craft", inputLength: 12, requestModelId: glm ? "glm-5.2" : "deepseek-v4-flash", requestModelName: glm ? "GLM-5.2" : "DeepSeek V4 Flash", isPlan: false, agentName: "default", agentType: "conversation" };
    }
    default: throw new Error(`未知事件类型：${spec.kind}`);
  }
}
