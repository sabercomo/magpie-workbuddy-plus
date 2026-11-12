// 运营活动: WorkBuddy × 星巴克 (2026-11-12 to 11-16). Its tasks count only
// real mini-program client actions; no server-side event or chat makes them
// progress (workbuddy2api-panel tried six ways on 2026-11-12). What can be
// automated is reading progress and claiming the rewards already earned.
//
// The module and activity code are fixed for this campaign. Once it ends, the
// config answers in_period: false and this is a no-op.
const module = "campaign", activity = "campaign_starbucks_2026";

export async function campaign(client) {
  const query = `activity_code=${encodeURIComponent(activity)}`;
  // The campaign lives in the mini program: send only its headers, not the desktop fingerprint.
  const headers = () => ({ Authorization: `Bearer ${client.account.auth.access}`, "X-User-Id": client.account.auth.uid, Accept: "application/json", "Content-Type": "application/json", "X-Client-Platform": "miniprogram" });
  const call = path => client.request(`/portal/activity/${module}/${path}`, { headers });
  const config = await call(`config?${query}`);
  if (config?.config?.in_period !== true) return { skipped: true, reason: "out-of-period" };
  const body = await call(`tasks?${query}`);
  const progress = new Map((body?.progress || []).map(p => [p.task_code, p.progress]));
  const tasks = (body?.tasks || []).map(t => ({ ...t, progress: progress.get(t.task_code) || 0 }));
  const ready = tasks.filter(t => t.enabled !== 0 && t.target_count > 0 && t.progress >= t.target_count && t.status !== "claimed");
  const claimed = [], errors = [];
  for (const task of ready) {
    const path = `tasks/${encodeURIComponent(task.task_code)}`;
    try {
      // Both steps are POSTs without a body; request() picks POST from `body`.
      await client.request(`/portal/activity/${module}/${path}/viewed?${query}`, { body: {}, headers });
      await client.request(`/portal/activity/${module}/${path}/claim?${query}`, { body: {}, headers });
      claimed.push(task.task_code);
    } catch (e) {
      // 12304 is the ordinary "not met yet" answer to a claim, not a failure.
      if (e.code !== 12304) errors.push(`${task.task_code}：${e.message}`);
    }
  }
  return { tasks: tasks.length, ready: ready.length, claimed: claimed.length, errors };
}
