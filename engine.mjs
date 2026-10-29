import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { calendar } from "./storage.mjs";
import { specs, manualTasks, buildEvent } from "./events.mjs";
import { UpstreamError } from "./client.mjs";

export const actions = ["all", "checkin", "activity", "tasks", "travel", "bonus", "night", "keepalive", "inspect"];

export async function perform(action, client, context) {
  const { account, config, state, log, checkpoint } = context;
  const today = () => calendar(new Date(), config.timezone).day;
  const reportKey = code => `${account.id}:${code}:${today()}`;
  const daily = async (name, run) => {
    const key = `${account.id}:${name}`;
    if (state.daily[key] === today()) { log(`${name}：今天已完成`); return { skipped: true }; }
    const result = await run();
    state.daily[key] = today();
    checkpoint();
    return result;
  };
  if (action === "keepalive") {
    const renewed = await client.refresh();
    log(renewed ? "登录已续期" : "登录未临近到期，无需续期");
    return { renewed, expires: account.auth.expires };
  }
  if (account.enterprise) { log("企业账号没有个人成长奖励，跳过"); return { skipped: true, reason: "enterprise" }; }
  const tasks = async () => {
    const result = await client.request("/v2/activity/growth/tasks");
    if (!Array.isArray(result?.tasks)) throw new Error("成长任务接口缺少 tasks 列表");
    return result.tasks;
  };
  const claim = async task => {
    const got = await client.request(`/activity/growth/tasks/${encodeURIComponent(task.task_code)}/claim`, { body: {} });
    log(`${task.title || task.task_code}：已领奖，${got?.credit ?? 0} 积分 / ${got?.energy ?? 0} 能量`);
    return got;
  };
  const completed = task => task.accept_status === "completed" || (task.progress?.target > 0 && task.progress.current >= task.progress.target);
  const progress = async task => {
    const code = task.task_code;
    if (task.accept_status === "claimed") return;
    if (completed(task)) return claim(task);
    const spec = specs[code];
    if (!spec) { log(`${task.title || code}：${manualTasks[code] || "尚未适配此任务"}${task.jump_url ? `（${task.jump_url}）` : ""}`); return; }
    if (spec.night) {
      const hour = calendar(new Date(), config.timezone).hour;
      if (hour >= 8 && hour < 23) { log("夜猫子任务：等待 23:00–08:00 时段"); return; }
    }
    if (task.accept_status === "not_accepted" && task.task_type !== "auto") {
      const accepted = await client.request("/v2/activity/growth/tasks/accept", { body: { task_codes: [code] } });
      const result = accepted?.results?.find(r => r.task_code === code);
      if (!["accepted", "already_accepted"].includes(result?.status)) throw new Error(`${code} 接取失败：${result?.message || result?.status || "响应缺少任务回执"}`);
    }
    if (!task.progress || !(task.progress.target > 0)) throw new Error(`${code} 缺少有效进度信息`);
    const key = reportKey(code);
    const amount = spec.night ? 1 : Math.max(0, task.progress.target - task.progress.current);
    const reporting = state.reports[key] || { sent: 0, total: amount, base: task.progress.current };
    if (reporting.sent) log(`${task.title || code}：今天已上报 ${reporting.sent} 次，核对上游进度`);
    for (let i = reporting.sent; i < reporting.total; i++) {
      await client.request("/v2/report", { body: [buildEvent(account.auth.uid, spec, reporting.base + i)] });
      reporting.sent = i + 1;
      state.reports[key] = reporting;
      checkpoint();
    }
    log(`${task.title || code}：累计已上报 ${reporting.sent} 次`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const updated = (await tasks()).find(t => t.task_code === code);
      if (!updated) throw new Error(`${code} 在进度查询中消失`);
      if (updated.accept_status === "claimed") return;
      if (completed(updated)) return claim(updated);
      if (attempt < 2) await delay(context.pollDelay ?? 1500, undefined, { signal: context.signal });
      else log(`${task.title || code}：上游进度 ${updated.progress.current}/${updated.progress.target}，尚未达成，未领奖`);
    }
  };

  const runTasks = async onlyNight => {
    const failures = [];
    const list = await tasks();
    if (onlyNight && !list.some(t => t.task_code === "black_cat")) {
      log("当前任务中心没有夜猫子任务");
      return { checked: 0, inactive: true };
    }
    // first_buddy unlocks acceptance of the other tasks and supplies the pet.
    list.sort((a, b) => Number(b.task_code === "first_buddy") - Number(a.task_code === "first_buddy"));
    for (const task of list) {
      if (onlyNight && task.task_code !== "black_cat") continue;
      try { await progress(task); }
      catch (e) { failures.push(`${task.task_code}：${e.message}`); log(failures.at(-1)); }
    }
    if (failures.length) throw new Error(`部分任务失败：${failures.join("；")}`);
    return { checked: list.length };
  };

  const checkin = () => daily("checkin", async () => {
    try {
      const result = await client.request("/v2/billing/meter/daily-checkin", { body: {}, billing: true, envelope: true });
      if (/处理中|请勿重复操作|系统繁忙|稍后再试|失败/.test(result.msg || "")) throw new Error(`签到尚未成功：${result.msg}`);
      log("Buddy 加油站：签到请求已成功，积分以账单为准");
      return result;
    } catch (e) {
      if (e instanceof UpstreamError && e.code === 10001 && /已签到/.test(e.message) && !/处理中|请勿重复操作|失败/.test(e.message)) {
        log("Buddy 加油站：今天已签到"); return { already: true };
      }
      throw e;
    }
  });
  const activity = () => daily("activity", async () => {
    await client.request("/v2/report", { body: [buildEvent(account.auth.uid, { kind: "chat" })] });
    const got = await client.request("/activity/growth/streak");
    if (!(got?.streak?.days > 0)) throw new Error("活跃已上报，但上游连登仍为 0，尚未确认生效");
    log(`国内活跃已生效，连续 ${got.streak.days} 天`);
    return got.streak;
  });
  const travel = async () => {
    const base = "/activity/growth/buddy/travel";
    let status = await client.request(base + "/status");
    if (status.state === "arrived") {
      const reward = await client.request(base + "/claim", { body: {} });
      log(`猫猫归来：已领取 ${reward?.reward_credit ?? 0} 积分`);
      status = await client.request(base + "/status");
    }
    if (status.state === "traveling") { log("猫猫正在旅行"); return status; }
    if (status.state !== "idle") throw new Error(`未知猫猫状态：${status.state}`);
    if (status.daily_limit_reached) { log("猫猫今日旅行已完成"); return status; }
    const configuration = await client.request(base + "/config");
    const location = configuration?.locations?.[0];
    if (location?.id === undefined) throw new Error("旅行配置没有可用目的地");
    const first = (await tasks()).find(t => t.task_code === "first_buddy");
    if (first && first.accept_status !== "claimed") await progress(first);
    const departed = await client.request(base + "/depart", { body: { location_id: location.id } });
    log(`猫猫已出发：${location.name || location.id}`);
    return departed;
  };
  const bonus = async () => {
    const heatmap = await client.request("/activity/growth/heatmap");
    let streak = await client.request("/activity/growth/streak");
    const yesterday = calendar(new Date(Date.now() - 86400_000), config.timezone).day;
    const cell = heatmap?.cells?.find(c => c.date === yesterday);
    if (cell && cell.score === 0 && streak.makeup_cards?.balance > 0) {
      await client.request("/activity/growth/makeup-cards/use", { body: { target_date: yesterday } });
      log(`已使用 1 张补签卡补签 ${yesterday}`);
      streak = await client.request("/activity/growth/streak");
    }
    const redemption = streak.redemption_status;
    for (const tier of redemption?.tiers || []) {
      const status = redemption[`tier_${tier.tier}_status`];
      if (["available", "claimable", "unlocked", "ready"].includes(status)) {
        await client.request("/activity/growth/redeem", { body: { tier: tier.tier, client_token: randomUUID() } });
        log(`已兑换连登 ${tier.tier} 档位`);
      }
    }
    const lottery = await client.request("/activity/growth/lottery/summary");
    for (let i = 0; i < lottery.chances; i++) {
      const result = await client.request("/activity/growth/lottery/draw", { body: { client_token: randomUUID() } });
      log(`成长抽奖 ${i + 1}/${lottery.chances}：${JSON.stringify(result)}`);
    }
    for (const [path, title] of [["claim-gift", "新手礼包"], ["claim-compensation", "活动补偿"]]) {
      const key = `${account.id}:${path}`;
      if (state.daily[key] === "settled") continue;
      try {
        const gift = await client.request(`/billing/meter/${path}`, { billing: true, body: {} });
        log(`${title}：已领取 ${gift?.credit ?? 0} 积分`);
        state.daily[key] = "settled";
      } catch (e) {
        if (!(e instanceof UpstreamError) || !/已领取|限领一次|无.*活动|活动.*结束|未开启|已过期|不符合|未满足/.test(e.message)) throw e;
        log(`${title}：${e.message}`);
        if (/已领取|限领一次/.test(e.message)) state.daily[key] = "settled";
      }
      checkpoint();
    }
    log("连登兑换、补签与抽奖检查完毕");
    return { days: streak.streak?.days, draws: lottery.chances };
  };
  if (action === "inspect") return {
    tasks: await tasks(), travel: await client.request("/activity/growth/buddy/travel/status"),
    streak: await client.request("/activity/growth/streak"), energy: await client.request("/v2/activity/growth/energy")
  };
  const handlers = { checkin, activity, tasks: () => runTasks(false), travel, bonus, night: () => runTasks(true) };
  if (action !== "all") return handlers[action]();
  const results = {}, failures = [];
  for (const [name, run] of Object.entries(handlers)) {
    if (name === "night") continue;
    try { results[name] = await run(); }
    catch (e) { results[name] = { error: e.message }; failures.push(name); log(`${name} 失败：${e.message}`); }
  }
  if (failures.length) throw new Error(`本轮有失败项目：${failures.join("、")}；详见执行记录`);
  return results;
}
