// The growth task "share a skill with a friend" is counted only after a real
// share channel exists. The market list and the channel API are the same ones
// workbuddy2api-hub uses; the events below are the channel actions the desktop
// client reports after copying its link.
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
  const shareCode = String(data?.share_code || "").trim();
  if (!shareCode) throw new Error("分享接口没有返回 share_code");
  return { shareCode, skillId, skillName };
}

export function skillShareEvents({ shareCode, skillId, skillName }) {
  const common = { skillId, skillName, skillType: "market" };
  const at = Date.now();
  return [
    { ...common, eventCode: "skill_share_channel_action", action: "link", panelAction: "click", panelType: "clipboard", isSuccessful: true, cost: 0, id: shareCode, actionAt: at },
    { ...common, eventCode: "skill_share_channel_action", action: "link", panelAction: "success", panelType: "clipboard", isSuccessful: true, cost: 0, id: shareCode, actionAt: at }
  ];
}
