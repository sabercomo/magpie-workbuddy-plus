// README screenshots only (docs/screenshots.sh): stands in for Magpie's page
// bridge with its light and dark theme tokens, picks the view from the query
// (?view=list&realm=cn&dark=1&to=.wb-sched) and shifts the page to a section.
(() => {
  const q = new URLSearchParams(location.search), dark = q.has("dark");
  const light = { bg: "#f4f4f6", card: "#ffffff", fg: "#1f1f24", muted: "#6e6e78", line: "#e3e3e8", accent: "#4f46e5", "accent-soft": "#eeedfd" };
  const night = { bg: "#1a1a1e", card: "#232327", fg: "#ececf1", muted: "#9a9aa6", line: "#34343b", accent: "#8b84ff", "accent-soft": "#2b2850" };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(dark ? night : light)) root.style.setProperty("--magpie-" + k, v);
  root.style.colorScheme = dark ? "dark" : "light";
  const base = document.createElement("style");
  base.textContent = ':where(html){background:var(--magpie-bg);color:var(--magpie-fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}:where(small,.muted){color:var(--magpie-muted)}:where(button){background:var(--magpie-card);border:1px solid var(--magpie-line);border-radius:6px;padding:3px 10px;color:inherit;font:inherit}:where(input,textarea,select){background:var(--magpie-card);border:1px solid var(--magpie-line);border-radius:6px;padding:4px 8px;color:inherit}';
  document.head.append(base);
  try { localStorage.setItem("wb-view", q.get("view") || "list"); if (q.get("realm")) localStorage.setItem("wb-realm", q.get("realm")); } catch {}
  globalThis.magpie = { options: { get: async () => ({}), set: async () => {} } };
  addEventListener("load", () => setTimeout(() => {
    for (const sel of (q.get("open") || "").split(",").filter(Boolean)) { const d = document.querySelector(sel); if (d) d.open = true; }
    const to = q.get("to"), el = to && document.querySelector(to);
    if (el) { const y = el.getBoundingClientRect().top - 24; document.body.style.transform = `translateY(${-y}px)`; }
  }, 300));
})();
