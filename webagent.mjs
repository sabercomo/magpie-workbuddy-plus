// WorkBuddy AI's daily activity reward (a 30 or 50 credit Bonus Pack) counts
// only a finished agent conversation on its web app, not the desktop chat
// event that lights the streak. This runs one, the way the web app does
// (worked out by workbuddy2api, v1.6.4 and #90):
//
//   1. POST /console/as/conversations/ with a prompt queues a conversation;
//   2. GET  …/{id}/session gives its sandbox: a link and a token;
//   3. the sandbox speaks ACP over streamable HTTP: a GET on the link opens an
//      event stream and names an Acp-Connection-Id, then JSON-RPC POSTs on the
//      same link send initialize → session/load → session/set_model →
//      session/prompt;
//   4. the conversation's status turns "completed" once the turn is done;
//   5. …/{id}/stop frees its slot (an account may hold 10 running ones); a
//      failed one is deleted so the web history doesn't fill with "Hi".
//
// The web app's own requests carry only the bearer token and X-User-Id, no
// desktop fingerprint, so the Magpie login works as it is. One short turn on
// a model free right now costs nothing; DeepSeek-V4.1-Flash, the fallback,
// about half a credit. The prompt asks for one word: a "Hi" drew 150 pieces
// of reply, all charged.

import { setTimeout as delay } from "node:timers/promises";

const web = "https://www.workbuddy.ai", conversations = web + "/console/as/conversations/";
const agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

export const fallback = "deepseek-v4.1-flash";

// The model for the day's conversation: the one set, or else a model free
// right now (0x, not only in some hours, open to this plan), Hy3 first as the
// web app is known to take it; none free, the fallback.
export function pickModel(list, wanted = "auto") {
  if (wanted && wanted !== "auto") return { id: wanted, why: "设置指定" };
  const paid = list?.plan?.paid === true;
  const free = (list?.models || []).filter(m => (m.rate === 0 || (m.promo?.rate === 0 && !m.promo.hours)) && (paid || !m.tier?.exclusive));
  const pick = free.find(m => m.id === "hy3") || free[0];
  return pick ? { id: pick.id, why: "当前免费" } : { id: fallback, why: "没有免费模型" };
}

export async function webActivity(client, { model = fallback, prompt = "只回复一个字：好", wait = 120_000, poll = 3000, sleep = delay } = {}) {
  await client.refresh();
  const a = client.account.auth, started = Date.now();
  const headers = { Authorization: `Bearer ${a.access}`, "X-User-Id": a.uid, "Content-Type": "application/json", Accept: "application/json, text/plain, */*", Origin: web, Referer: web + "/app", "User-Agent": agent };
  const call = async (url, body) => {
    const response = await client.fetch(url, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`网页会话：HTTP ${response.status}，不是 JSON`); }
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      if (body?.model) client.recordLimit(body.model, payload);
      const full = payload.code === 10105 || /active conversation|会话.*上限/i.test(payload.msg || "");
      throw new Error(full ? "网页会话：活跃会话已满 10 条，请到 workbuddy.ai 网页端结束几条旧对话" : `网页会话：HTTP ${response.status}，${payload.msg || `code=${payload.code}`}`);
    }
    if (body?.model) client.clearLimit(body.model);
    return payload.data;
  };

  const id = (await call(conversations, { prompt, model, conversationOrigin: "workbuddy-app", plugins: [{ name: "weixinpay", marketplace: "codebuddy-builtin" }] }))?.id;
  if (!id) throw new Error("网页会话：建会话没有返回 id");
  const stream = new AbortController();
  let done = false, chunks = 0;
  try {
    // The sandbox may take a moment to come up.
    let session;
    for (let i = 0; i < 10; i++) {
      session = await call(conversations + encodeURIComponent(id) + "/session");
      if (session?.link && session?.token) break;
      await sleep(1500);
    }
    if (!session?.link || !session?.token) throw new Error("网页会话：沙箱没有就绪");
    const sid = session.sessionId || id, auth = { Authorization: `Bearer ${session.token}`, "User-Agent": agent };
    const opened = await client.fetcher(session.link, { headers: { ...auth, Accept: "text/event-stream" }, signal: stream.signal, ...(client.config.proxy ? { proxy: client.config.proxy } : {}) });
    const connection = opened.headers.get("acp-connection-id");
    if (!opened.ok || !connection) throw new Error(`网页会话：沙箱事件流 HTTP ${opened.status}${connection ? "" : "，没有 Acp-Connection-Id"}`);
    // Read the stream so the sandbox can push its updates; count the reply's pieces.
    (async () => {
      const reader = opened.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buffer += decoder.decode(value, { stream: true });
          for (let k; (k = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(k + 1)) {
            const line = buffer.slice(0, k).trim();
            if (line.includes('"agent_message_chunk"')) chunks++;
          }
        }
      } catch {}
    })();
    const rpc = async (n, method, params) => {
      const response = await client.fetcher(session.link, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Acp-Connection-Id": connection }, body: JSON.stringify({ jsonrpc: "2.0", id: n, method, params }), signal: AbortSignal.timeout(30_000), ...(client.config.proxy ? { proxy: client.config.proxy } : {}) });
      await response.text();
      if (![200, 202].includes(response.status)) throw new Error(`网页会话：${method} HTTP ${response.status}`);
    };
    await rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    await rpc(2, "session/load", { sessionId: sid, cwd: session.cwd || "/workspace", mcpServers: [] });
    // Without this the turn runs on the account's default (Auto, a paid model).
    await rpc(3, "session/set_model", { sessionId: sid, modelId: model }).catch(() => {});
    await rpc(4, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text: prompt }] });
    let status = "";
    for (const until = Date.now() + wait; Date.now() < until;) {
      await sleep(poll);
      status = String((await call(conversations + encodeURIComponent(id)).catch(() => null))?.status || "").toLowerCase();
      if (status === "completed") { done = true; break; }
      if (["failed", "error"].includes(status)) throw new Error(`网页会话：会话状态 ${status}`);
    }
    if (!done) throw new Error(`网页会话：${Math.round(wait / 1000)} 秒内没有跑完（状态 ${status || "未知"}）`);
    return { conversation: id, model, chunks, ms: Date.now() - started };
  } finally {
    stream.abort();
    // Always free the slot; a turn that didn't finish leaves nothing worth keeping.
    await call(conversations + encodeURIComponent(id) + "/stop", {}).catch(() => {});
    if (!done) await call(conversations + encodeURIComponent(id) + "/delete", {}).catch(() => {});
  }
}
