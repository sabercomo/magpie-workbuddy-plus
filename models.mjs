import { UpstreamError } from "./client.mjs";

// The model lists WorkBuddy's own client shows, from its product config
// (/v3/config): each model's credit multiplier, context, the tier that gates
// it and any promotion running, plus the account's plan from the billing
// summary. Read only: no model is called and no credit is spent.
const round = n => Math.round(n * 100) / 100;
const china = "https://copilot.tencent.com", intl = "https://www.workbuddy.ai";

// "x0.34 credits", "x0.00", "0.50x" and 0 are rates; "" (Auto) floats with the task.
export function creditsOf(c) {
  const s = String(c ?? "").trim().toLowerCase().replace(/\s+credits?$/, "").replace(/^x|x$/g, "");
  const n = Number(s);
  return s !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}

const hhmm = t => String(t).replace(/^(\d):/, "0$1:");
const live = (p, now) => p && p.enabled !== false && !(Date.parse(p.schedule?.validFrom) > now) && !(Date.parse(p.schedule?.validUntil) <= now);

// A tier whose badge says "Only" (WorkBuddy AI's "Pro Only") shuts the model to
// free plans; China's 「订阅优先」 only queues free plans behind members.
const exclusive = t => /only|专属|仅限/i.test(`${t.badge?.label || ""} ${t.badge?.labelEn || ""}`);

export function catalog(cfg, now = Date.now()) {
  const ids = (cfg?.agents || []).find(a => a.name === "cli")?.models || [];
  const tiers = (cfg?.modelTiers || []).filter(t => t.enabled !== false);
  const promos = (cfg?.modelPromotions || []).filter(p => p.kind === "discount" && live(p, now));
  const list = ids.map(id => {
    const d = (cfg.models || []).find(m => m.id === id) || {}, rate = creditsOf(d.credits);
    const row = { id, name: d.name || id, desc: d.descriptionZh || d.descriptionEn || "", rate, context: Number(d.maxInputTokens) || 0, isDefault: d.isDefault === true };
    const tier = tiers.find(t => t.modelIds?.includes(id));
    if (tier) row.tier = { label: tier.badge?.label || tier.badge?.labelEn || "", note: tier.hover?.textZh || tier.hover?.textEn || "", exclusive: exclusive(tier) };
    // A model may carry a badge-only promotion beside the one that prices it
    // (GLM-5.2's daytime 「夜间折扣」 badge and its 23:00–08:00 discount).
    const offers = promos.filter(p => p.modelIds?.includes(id)), label = offers.map(p => p.badge?.label).find(Boolean);
    if (label) {
      const priced = offers.find(p => p.discount), said = priced && creditsOf(priced.discount.discountedCredits), factor = Number(priced?.discount?.factor);
      const note = offers.map(p => p.hover?.textZh || p.hover?.textEn).find(Boolean) || "";
      // DeepSeek's off-peak discount is a badge alone: its price is only in its
      // words (「非高峰期积分5折」), read as the factor they name.
      const told = !priced && rate !== null && note.match(/(\d+(?:\.\d+)?)\s*折/);
      const off = said ?? (Number.isFinite(factor) && rate !== null ? round(rate * factor) : told ? round(rate * told[1] / 10) : null);
      row.promo = {
        label, note,
        hours: priced ? (priced.schedule?.daily || []).map(h => `${hhmm(h.start)}–${hhmm(h.end)}`).join("、") : told && /非高峰/.test(note) ? "非高峰" : "",
        until: Math.max(0, ...offers.map(p => Date.parse(p.schedule?.validUntil) || 0)), ...(off !== null ? { rate: off } : {}), ...(told ? { approx: true } : {})
      };
    }
    return row;
  });
  // Two ids under one name (China's hy3 and hy3-x are both "Hy3") read apart by their suffix.
  const first = new Map();
  for (const m of list) {
    const id = first.get(m.name);
    if (id === undefined) { first.set(m.name, m.id); continue; }
    m.name = `${m.name} (${m.id.startsWith(id + "-") ? m.id.slice(id.length + 1).toUpperCase() : m.id})`;
  }
  return list;
}

const planOf = sum => {
  const s = sum?.Response?.Data ?? sum ?? {};
  return { name: s.SubscriptionPackageName || (s.IsPaidUser ? "Pro" : "Free"), paid: s.IsPaidUser === true };
};

// China: through a domestic account's client, which keeps its login renewed.
export async function chinaModels(client, now = Date.now()) {
  const models = catalog(await client.request("/v3/config", { base: china }), now);
  const plan = planOf(await client.request("/billing/meter/get-user-resource-summary", { body: {}, base: china }));
  return { models, plan, account: client.account.name };
}

// International: its login is Magpie's to renew, so an expired one is reported,
// never refreshed here.
export async function intlModels(account, { fetcher = fetch, proxy = "", now = Date.now() } = {}) {
  const a = account.auth;
  if (a.expires && a.expires <= now) throw new Error("国际版登录已过期，请在 Magpie 重新登录 WorkBuddy AI");
  const headers = {
    Authorization: `Bearer ${a.access}`, "X-User-Id": a.uid ?? "", "X-Domain": a.domain || new URL(intl).host, "X-Product": "SaaS",
    "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy", "X-IDE-Version": "5.9.3", "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0", Accept: "application/json", "Content-Type": "application/json"
  };
  const call = async (path, body) => {
    const response = await fetcher(intl + path, { method: body ? "POST" : "GET", headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(30_000), ...(proxy ? { proxy } : {}) });
    let payload = {};
    try { payload = JSON.parse(await response.text()); } catch {}
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) throw new UpstreamError(path, response.status, payload);
    return payload.data;
  };
  return { models: catalog(await call("/v3/config"), now), plan: planOf(await call("/billing/meter/get-user-resource-summary", "{}")), account: account.name };
}
