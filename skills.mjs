// The growth task "share a skill with a friend" is counted only after a real
// share channel exists. The market and channel APIs follow workbuddy2api-hub;
// the single desktop success receipt follows WorkBuddy-Daily v3.51.
import { channel } from "./events.mjs";

const market = "https://www.codebuddy.cn";
const open = "https://open.workbuddy.cn";
const preferred = "skill_2097350077599879168";

const display = value => typeof value === "string" ? value : value?.zh || value?.en || "";
const fallbackName = id => `技能 ${id.slice(-6)}`;

export async function createSkillShare(client, account) {
  const headers = () => channel("desktop", account).headers;
  const list = await client.request("/v2/operation-platform/market/skill/list", {
    base: market, body: { page: 1, page_size: 20 }, headers
  });
  const skills = list?.skills || [];
  const skill = skills.find(s => String(s.skill_id || s.id || "") === preferred) || skills[0];
  if (!skill) throw new Error("技能市场没有返回可分享的技能");
  const skillId = String(skill.skill_id || skill.id || "").trim();
  const skillName = (display(skill.display_name_zh) || display(skill.name) || display(skill.display_name_en) || fallbackName(skillId)).trim();
  if (!skillId) throw new Error("技能市场返回的技能缺少 id");
  const data = await client.request("/api/v2/open-platform/asset-shares/c2c/channels", {
    base: open,
    body: {
      asset_kind: "skill",
      asset_source: "market",
      asset_ref: JSON.stringify({ asset_id: skillId }),
      ways: ["link", "wxacode", "wxapath"],
      extra: { name: skillName, description: String(skill.description_zh || skill.description || "").slice(0, 60), shareKey: skillId, marketplaceSource: "builtin-market" }
    },
    headers
  });
  const channelId = String(data?.channel_id || "").trim();
  const shareCode = String(data?.share_code || "").trim();
  const link = Array.isArray(data?.ways) && data.ways.find(way => way?.share_way === "link" &&
    typeof way.resource_ref === "string" && way.resource_ref.trim());
  if (!channelId || !shareCode || !link) throw new Error("分享渠道回执缺少渠道编号、分享码或链接");
  return { channelId, skillId, skillName };
}

export function skillShareEvents({ channelId, skillId, skillName }) {
  return [{
    eventCode: "skill_share_channel_action", skillId, skillName, skillType: "market", skillSource: "market",
    action: "wechat", panelAction: "success", panelType: "mini_program_card", isSuccessful: true, cost: 0,
    id: channelId, actionAt: Date.now(), entry: "skill_detail", status: "safe", actionSuccessful: true
  }];
}
