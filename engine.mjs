import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { calendar } from "./storage.mjs";
import { specs, unreachable, buildEvent, buildEvents, growthTasks, miniProgram } from "./events.mjs";
import { UpstreamError } from "./client.mjs";
import { fallback, pickModel, webActivity } from "./webagent.mjs";

export const actions = ["all", "activity", "tasks", "travel", "bonus", "night", "keepalive", "web", "inspect"];

// A round whose every failure was a rate limit is deferred, not failed.
function roundError(message, errors) {
  const e = new Error(message);
  e.limited = errors.length > 0 && errors.every(x => x.limited);
  return e;
}

export async function perform(action, client, context) {
  const { account, config, state, log, checkpoint } = context;
  const today = () => calendar(new Date(), config.timezone).day;
  const reportKey = code => `${account.id}:${code}:${today()}`;
  const daily = async (name, run) => {
    const key = `${account.id}:${name}`;
    if (state.daily[key] === today()) { log(`${{ activity: "连登活跃", web: "国际版网页会话" }[name] || name}：今天已完成`); return { skipped: true }; }
    const result = await run();
    state.daily[key] = today();
    checkpoint();
    return result;
  };
  const intl = account.realm === "intl", where = intl ? "国际版" : "国内";
  if (action === "keepalive") {
    const renewed = await client.refresh();
    log(renewed ? `${intl ? "国际版" : ""}登录已续期` : "登录未临近到期，无需续期");
    return { renewed, expires: account.auth.expires };
  }
  if (account.enterprise) { log("企业账号没有个人成长奖励，跳过"); return { skipped: true, reason: "enterprise" }; }
  // The mini program's own tasks are listed, accepted and claimed only as
  // a mini-program client; `mp` asks that way.
  const as = mp => mp ? { extra: miniProgram } : {};
  const tasks = async mp => {
    const result = await client.request("/v2/activity/growth/tasks", as(mp));
    if (!Array.isArray(result?.tasks)) throw new Error("成长任务接口缺少 tasks 列表");
    return growthTasks(result.tasks).map(t => mp ? { ...t, mp: true } : t);
  };
  const claim = async task => {
    const path = `/activity/growth/tasks/${encodeURIComponent(task.task_code)}/claim`;
    let got;
    try { got = await client.request(path, { body: {}, ...as(task.mp) }); }
    // Some mini-program tasks are claimed the ordinary way instead.
    catch (e) { if (!task.mp || e.status !== 400) throw e; got = await client.request(path, { body: {} }); }
    log(`${task.title || task.task_code}：已领奖，${got?.credit ?? 0} 积分 / ${got?.energy ?? 0} 能量`);
    return got;
  };
  const completed = task => task.accept_status === "completed" || (task.progress?.target > 0 && task.progress.current >= task.progress.target);
  const progress = async task => {
    const code = task.task_code;
    if (task.accept_status === "claimed") return "done";
    if (completed(task)) return claim(task).then(() => "claimed");
    // What only a person can do (a donation, following an account, WorkBuddy
    // AI's client-only tasks) is left alone and not listed; it is still
    // claimed above once its progress is there. A task not known yet is
    // listed for a person, as before.
    if (task.intl || unreachable.has(code)) return "skip";
    const spec = specs[code];
    if (!spec) { log(`${task.title || code}：尚未适配此任务${task.jump_url ? `（${task.jump_url}）` : ""}`); return task.locked === true ? "skip" : "manual"; }
    if (task.locked === true) return "skip";
    if (spec.night) {
      const hour = calendar(new Date(), config.timezone).hour;
      if (hour >= 8 && hour < 23) { log("夜猫子任务：等待 23:00–08:00 时段"); return "open"; }
    }
    if (task.accept_status === "not_accepted" && task.task_type !== "auto") {
      let accepted;
      try { accepted = await client.request("/v2/activity/growth/tasks/accept", { body: { task_codes: [code] }, ...as(task.mp) }); }
      // The mini program's tasks open one after another, a day apart.
      catch (e) { if (!task.mp || e.limited) throw e; log(`${task.title || code}：还不能接取（${e.message}）`); return "open"; }
      const result = accepted?.results?.find(r => r.task_code === code);
      if (task.mp) {
        // An accept can answer OK without taking: read the task back.
        task = (await tasks(true)).find(t => t.task_code === code) || task;
        if (task.accept_status === "not_accepted") { log(`${task.title || code}：还不能接取${result?.message ? `（${result.message}）` : ""}`); return "open"; }
        if (task.accept_status === "claimed") return "done";
        if (completed(task)) return claim(task).then(() => "claimed");
      }
      else if (!["accepted", "already_accepted"].includes(result?.status)) throw new Error(`${code} 接取失败：${result?.message || result?.status || "响应缺少任务回执"}`);
    }
    // A mini-program task not yet counted has no progress to read; its own target stands in.
    const had = task.progress?.target > 0 ? task.progress : spec.target ? { current: 0, target: spec.target } : null;
    if (!had) throw new Error(`${code} 缺少有效进度信息`);
    const key = reportKey(code);
    const amount = spec.night ? 1 : Math.max(0, had.target - had.current);
    const reporting = state.reports[key] || { sent: 0, total: amount, base: had.current };
    if (reporting.sent) log(`${task.title || code}：今天已上报 ${reporting.sent} 次，核对上游进度`);
    if (spec.pace && reporting.sent < reporting.total) log(`${task.title || code}：要按真人节奏上报，约需 ${Math.ceil((reporting.total - reporting.sent) * (context.pace ?? spec.pace + 5000) / 60_000)} 分钟`);
    for (let i = reporting.sent; i < reporting.total; i++) {
      // Reports sent in a burst are counted, then rolled back: wait before each, the first too.
      if (spec.pace) await delay(context.pace ?? spec.pace + Math.random() * 10_000, undefined, { signal: context.signal });
      await client.report(buildEvents(account, spec, reporting.base + i), spec.via);
      reporting.sent = i + 1;
      state.reports[key] = reporting;
      checkpoint();
    }
    log(`${task.title || code}：累计已上报 ${reporting.sent} 次`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const updated = (await tasks(task.mp)).find(t => t.task_code === code);
      if (!updated) throw new Error(`${code} 在进度查询中消失`);
      if (updated.accept_status === "claimed") return "done";
      if (completed(updated)) return claim(updated).then(() => "claimed");
      if (attempt < 2) await delay(context.pollDelay ?? 1500, undefined, { signal: context.signal });
      else log(`${task.title || code}：上游进度 ${updated.progress?.current ?? 0}/${updated.progress?.target ?? had.target}，尚未达成，未领奖`);
    }
    return "open";
  };

  const runTasks = async onlyNight => {
    const failures = [], errors = [];
    const list = await tasks();
    // The mini program's tasks come only in its own list; each is done after the one before it.
    if (!intl && !onlyNight) {
      try { list.push(...(await tasks(true)).filter(t => !list.some(x => x.task_code === t.task_code)).sort((a, b) => String(a.task_code).localeCompare(String(b.task_code)))); }
      catch (e) { if (e.limited) throw e; log(`小程序任务列表读取失败：${e.message}`); }
    }
    if (onlyNight && !list.some(t => t.task_code === "black_cat")) {
      log("当前任务中心没有夜猫子任务");
      return { checked: 0, inactive: true };
    }
    // first_buddy unlocks acceptance of the other tasks and supplies the pet.
    list.sort((a, b) => Number(b.task_code === "first_buddy") - Number(a.task_code === "first_buddy"));
    const outcome = { claimed: 0, open: 0, manual: [] };
    for (const task of list) {
      if (onlyNight && task.task_code !== "black_cat") continue;
      try {
        const got = await progress(task);
        if (got === "manual") outcome.manual.push(task.title || task.task_code);
        else if (got in outcome) outcome[got]++;
      }
      catch (e) { failures.push(`${task.task_code}：${e.message}`); errors.push(e); log(failures.at(-1)); }
    }
    if (failures.length) throw roundError(`部分任务失败：${failures.join("；")}`, errors);
    // The job row shows the last line, so it says what this run left undone.
    if (!onlyNight) log([`本次领奖 ${outcome.claimed} 项`, outcome.open && `${outcome.open} 项未达成`,
      outcome.manual.length && `${outcome.manual.length} 项尚未适配：${outcome.manual.join("、")}`].filter(Boolean).join("；"));
    return { checked: list.length };
  };

  // WorkBuddy AI counts a chat to one of its own models.
  const report = () => daily("activity", async () => {
    await client.request("/v2/report", { body: [buildEvent(account.auth.uid, { kind: "chat", ...(intl ? { model: ["deepseek-v4.1-flash-sg", "Deepseek-V4.1-Flash"] } : {}) })] });
    const got = await client.request("/activity/growth/streak");
    if (!(got?.streak?.days > 0)) throw new Error("活跃已上报，但上游连登仍为 0，尚未确认生效");
    log(`${where}活跃已生效，连续 ${got.streak.days} 天`);
    return got.streak;
  });
  const activity = report;
  // That lights WorkBuddy AI's streak but not its daily reward (30/50
  // credits), which takes a finished conversation on its web app: one a day,
  // in its own slot, on a model free right now when there is one. If that
  // model turns it down (its free allowance spent, say), DeepSeek-V4.1-Flash
  // runs it instead.
  const web = async () => {
    if (!intl) return { skipped: true, reason: "cn" };
    if (config.intlWeb === false) { log("国际版网页会话已关闭"); return { skipped: true, reason: "off" }; }
    return daily("web", async () => {
      const chosen = pickModel(context.models, config.intlWebModel);
      let got;
      try { got = await webActivity(client, { ...context.web, model: chosen.id }); }
      catch (e) {
        if (chosen.id === fallback) throw e;
        log(`国际版网页会话用 ${chosen.id} 没跑完（${e.message}），改用 ${fallback}`);
        got = await webActivity(client, { ...context.web, model: fallback });
      }
      const why = got.model === chosen.id ? chosen.why : "备用";
      log(`国际版网页会话已跑完（${got.model}${why ? `，${why}` : ""}，${Math.round(got.ms / 1000)} 秒），每日活跃奖励通常次日凌晨到账`);
      return got;
    });
  };
  const travel = async () => {
    // WorkBuddy AI has no Buddy travel: nothing is asked and nothing logged.
    if (intl) return { skipped: true, reason: "intl" };
    const base = "/activity/growth/buddy/travel";
    let status = await client.request(base + "/status");
    if (!status?.state) { log("还没有可旅行的猫猫，跳过"); return { skipped: true }; }
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
  // WorkBuddy AI's daily check-in, claimed only while it runs a check-in
  // campaign; China's stays with Magpie's own plugin.
  const checkin = async () => {
    const status = await client.request("/v2/billing/meter/checkin-activity-status", { billing: true, body: {} });
    if (!status?.active) { log("国际版目前没有签到活动，开启后会自动签到"); return { outcome: "closed" }; }
    if (status.today_checked_in) { log("国际版今天已签到"); return { outcome: "done" }; }
    try {
      const got = await client.request("/v2/billing/meter/daily-checkin", { billing: true, body: {} });
      log(`国际版签到：+${got?.credit ?? status.daily_credit ?? 0} 积分`);
      return { outcome: "claimed", credit: got?.credit };
    } catch (e) {
      const said = { 1001: "国际版今天已签到", 1003: "国际版签到需要账号当天先活跃", 10001: "国际版签到活动未开启或已过期" }[e.code];
      if (!said) throw e;
      log(said);
      return { outcome: e.code === 1001 ? "done" : "closed" };
    }
  };
  const bonus = async () => {
    if (intl) await checkin();
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
    // The starter gift and compensation are China's billing; WorkBuddy AI has neither.
    for (const [path, title] of intl ? [] : [["claim-gift", "新手礼包"], ["claim-compensation", "活动补偿"]]) {
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
    tasks: await tasks(), ...(intl ? {} : { travel: await client.request("/activity/growth/buddy/travel/status") }),
    streak: await client.request("/activity/growth/streak"), energy: await client.request("/v2/activity/growth/energy")
  };
  const handlers = { activity, tasks: () => runTasks(false), travel, bonus, night: () => runTasks(true), web };
  if (action !== "all") return handlers[action]();
  if (intl) delete handlers.travel;
  else delete handlers.web;
  const results = {}, failures = [], errors = [];
  for (const [name, run] of Object.entries(handlers)) {
    if (name === "night") continue;
    try { results[name] = await run(); }
    catch (e) { results[name] = { error: e.message }; failures.push(name); errors.push(e); log(`${name} ${e.limited ? "被限流" : "失败"}：${e.message}`); }
  }
  if (failures.length) throw roundError(`本轮有${errors.every(e => e.limited) ? "被限流的" : "失败"}项目：${failures.join("、")}；详见执行记录`, errors);
  return results;
}
