// The sidebar cannot call the service. Host options survive an iframe reload;
// only read them on recovery. Never replay a request to discover its result.
globalThis.WBRequests = function ({ options, receipt, changed, history, wake }) {
  const jobs = new Set(["all", "activity", "tasks", "sweep", "task", "travel", "buddy", "bonus", "compensation", "night", "web", "inspect", "retry"]);
  let active, sending = false, receiptTimer, started = false, inspected = false;
  const locked = () => !!active;
  // History state survives a same-frame refresh, even when sandbox storage is unavailable.
  // A newly mounted iframe instead reads the durable host options. Neither path writes options.
  function remember(request) {
    try { history?.replaceState({ ...history.state, wbPending: request && { id: request.id, action: request.action, ...(request.until ? { until: request.until } : {}) } }, ""); }
    catch (e) { if (e.name !== "SecurityError") throw e; }
  }
  function show(request, phase, detail = "") {
    changed({ action: request.action, phase, detail });
  }
  function finish(phase, detail) {
    clearTimeout(receiptTimer);
    const previous = active;
    active = null;
    remember(null);
    show(previous, phase, detail);
  }
  function receive(ack) {
    if (!active || active.reading || ack?.id !== active.id || typeof ack.ok !== "boolean") return;
    active.observed = true;
    if (ack.ok) finish("accepted");
    else if (ack.beforeDispatch === true) finish("rejected", ack.error);
    else {
      clearTimeout(receiptTimer);
      show(active, "unknown", ack.error);
    }
  }
  function unresolved(request) {
    if (!request?.id || !jobs.has(request.action)) return false;
    const ack = receipt();
    return !(ack?.id === request.id && (ack.ok === true || (ack.ok === false && ack.beforeDispatch === true)));
  }
  function awaitReceipt(request) {
    show(request, "awaiting");
    receiptTimer = setTimeout(() => { if (active === request) show(request, "unknown"); }, request.until - Date.now());
  }
  function recover(request) {
    active = { id: request.id, action: request.action };
    show(active, "unknown", receipt()?.id === request.id ? receipt().error : "");
  }
  // Timing out the await of get (not a chain containing set) prevents a late read from writing.
  async function within(operation, ms) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Magpie 没有响应")), ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  return {
    locked, receive, canUpgrade: () => inspected && !sending && !active, isJob: action => jobs.has(action),
    async restore() {
      let marker;
      try { marker = history?.state?.wbPending; }
      catch (e) { if (e.name !== "SecurityError") throw e; }
      if (marker?.id && jobs.has(marker.action)) {
        active = { id: marker.id, action: marker.action };
        if (receipt()?.id === marker.id && typeof receipt().ok === "boolean") receive(receipt());
        else if (marker.until > Date.now() && marker.until <= Date.now() + 30_000) {
          active.until = marker.until;
          awaitReceipt(active);
        } else recover(marker);
      }
      let saved;
      try { saved = (await within(options.get(), 10_000))?.request; }
      catch { return; } // Every write also checks the host's saved request before replacing it.
      if (started || (active && active.id !== saved?.id)) return;
      inspected = true;
      if (active || !saved?.id || !jobs.has(saved.action)) return;
      if (unresolved(saved)) recover(saved);
      else if (!marker && Date.now() - saved.at >= 0 && Date.now() - saved.at < 30_000) {
        // The host may already have published the ACK before the new frame
        // starts, including in a browser that did not retain the history marker.
        active = { id: saved.id, action: saved.action };
        receive(receipt());
      }
    },
    async send(changes) {
      if (active || sending) throw new Error("请先确认上一次请求的状态");
      started = sending = true;
      const request = changes.request, job = jobs.has(request?.action);
      const current = job ? { id: request.id, action: request.action, reading: true } : null;
      if (job) { active = current; show(current, "submitting"); }
      const deadline = Date.now() + 10_000;
      try {
        let saved;
        try {
          saved = await within(options.get(), 10_000);
          if (Date.now() >= deadline) throw new Error("读取超时");
        } catch {
          if (job) finish("not-submitted");
          throw new Error("没有读到 Magpie 设置，本次未写入请求");
        }
        inspected = true;
        if (unresolved(saved?.request)) {
          recover(saved.request);
          throw new Error("请先确认上一次请求的状态");
        }
        if (job) { current.reading = false; remember(current); }
        const next = { ...saved, ...changes };
        // A sync-only write must not re-deliver a previous, already resolved task.
        if (!changes.request && jobs.has(saved?.request?.action)) delete next.request;
        try {
          await within(options.set(next), Math.max(1, deadline - Date.now()));
        } catch {
          if (!job) throw new Error("未能确认写入结果，请先核对状态");
          if (active === current) show(current, "unknown");
          return;
        }
        if (job && active === current) {
          // A matching error receipt may already have arrived during the host write.
          if (current.observed) return;
          if (receipt()?.id === current.id && typeof receipt().ok === "boolean") receive(receipt());
          else if (Date.now() >= deadline) show(current, "unknown");
          else {
            current.until = Date.now() + 30_000;
            remember(current);
            awaitReceipt(current);
            // Only this live set-success continuation may warm the host. A
            // restored page waits for the same receipt; it never calls wake.
            if (active === current && !current.observed) {
              try { wake(); }
              catch (e) {
                if (e.name !== "SecurityError") throw e;
                clearTimeout(receiptTimer);
                show(current, "unknown");
              }
            }
          }
        }
      } finally { sending = false; }
    }
  };
};
