// The sidebar cannot call the service. Host options survive an iframe reload;
// only read them on recovery. Never replay a request to discover its result.
globalThis.WBRequests = function ({ options, receipt, changed, history, wake }) {
  const jobs = new Set(["all", "activity", "tasks", "sweep", "task", "travel", "buddy", "bonus", "compensation", "night", "web", "inspect", "retry"]);
  const maxAge = 10 * 60_000, receiptWait = 30_000; // The runner also rejects first deliveries at ten minutes.
  let active, sending = false, receiptTimer, expiryTimer, started = false, inspected = false;
  const locked = () => !!active && !active.expired;
  // History state survives a same-frame refresh, even when sandbox storage is unavailable.
  // A newly mounted iframe instead reads the durable host options. Neither path writes options.
  function remember(request) {
    try { history?.replaceState({ ...history.state, wbPending: request && { id: request.id, action: request.action, at: request.at, ...(request.until ? { until: request.until } : {}) } }, ""); }
    catch (e) { if (e.name !== "SecurityError") throw e; }
  }
  function show(request, phase, detail = "") {
    changed({ id: request.id, action: request.action, phase, detail });
  }
  function finish(phase, detail) {
    clearTimeout(receiptTimer);
    clearTimeout(expiryTimer);
    const previous = active;
    active = null;
    remember(null);
    show(previous, phase, detail);
  }
  function receive(ack = active && receipt(active.id)) {
    if (!active || active.reading || ack?.id !== active.id || typeof ack.ok !== "boolean") return;
    active.observed = true;
    if (ack.ok) finish("accepted");
    else if (ack.beforeDispatch === true) finish("rejected", ack.error);
    else if (!active.expired) {
      clearTimeout(receiptTimer);
      show(active, "unknown", ack.error);
    }
  }
  function unresolved(request) {
    if (!request?.id || !jobs.has(request.action)) return false;
    const ack = receipt(request.id);
    return !(ack?.id === request.id && (ack.ok === true || (ack.ok === false && ack.beforeDispatch === true)));
  }
  function watchExpiry(request) {
    clearTimeout(expiryTimer);
    const expire = () => {
      if (request !== active || request.expired) return;
      if (!unresolved(request)) return receive();
      request.expired = true;
      clearTimeout(receiptTimer);
      remember(null);
      show(request, "expired");
    };
    const remaining = request.at + maxAge - Date.now();
    if (remaining > 0) expiryTimer = setTimeout(expire, remaining);
    else expire();
  }
  function awaitReceipt(request) {
    show(request, "awaiting");
    receiptTimer = setTimeout(() => { if (active === request) show(request, "unknown"); }, request.until - Date.now());
  }
  function recover(request) {
    const current = active = { id: request.id, action: request.action, at: Number(request.at) };
    const ack = receipt(request.id);
    remember(current);
    watchExpiry(current);
    if (active === current && !current.expired) show(current, "unknown", ack?.id === request.id ? ack.error : "");
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
    locked, receive, canUpgrade: () => inspected && !sending && !locked(), isJob: action => jobs.has(action),
    async restore() {
      let marker;
      try { marker = history?.state?.wbPending; }
      catch (e) { if (e.name !== "SecurityError") throw e; }
      if (marker?.id && jobs.has(marker.action)) {
        // Previous builds only recorded the receipt deadline, or neither time after a write timeout.
        const at = Number(marker.at ?? (marker.until ? marker.until - receiptWait : Date.now()));
        const current = active = { id: marker.id, action: marker.action, at };
        const ack = receipt(marker.id);
        if (ack?.id === marker.id && typeof ack.ok === "boolean") receive(ack);
        else if (marker.until > Date.now() && marker.until <= Date.now() + receiptWait) {
          current.until = marker.until;
          awaitReceipt(current);
        } else show(current, "unknown");
        if (active === current) {
          remember(current);
          watchExpiry(current);
        }
      }
      let saved;
      try { saved = (await within(options.get(), 10_000))?.request; }
      catch { return; } // Every write also checks the host's saved request before replacing it.
      if (started) return;
      inspected = true;
      if (active && active.id === saved?.id) {
        const at = Number(saved.at);
        if (!active.expired && Number.isFinite(at)) {
          active.at = at;
          remember(active);
          watchExpiry(active);
        }
        return;
      }
      if (locked() || !saved?.id || !jobs.has(saved.action)) return;
      if (unresolved(saved)) recover(saved);
      else if (!marker && Date.now() - saved.at >= 0 && Date.now() - saved.at < 30_000) {
        // The host may already have published the ACK before the new frame
        // starts, including in a browser that did not retain the history marker.
        active = { id: saved.id, action: saved.action };
        receive();
      }
    },
    async send(changes) {
      if (locked() || sending) throw new Error("请先确认上一次请求的状态");
      started = sending = true;
      const request = changes.request, job = jobs.has(request?.action);
      const current = job ? { id: request.id, action: request.action, at: request.at, reading: true } : null;
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
        if (unresolved(saved?.request) && Date.now() - saved.request.at < maxAge) {
          recover(saved.request);
          throw new Error("请先确认上一次请求的状态");
        }
        if (job) { current.reading = false; remember(current); watchExpiry(current); }
        const next = { ...saved, ...changes };
        // A sync-only write must not re-deliver a previous, already resolved task.
        if (!changes.request && jobs.has(saved?.request?.action)) delete next.request;
        try {
          await within(options.set(next), Math.max(1, deadline - Date.now()));
        } catch {
          if (!job) throw new Error("未能确认写入结果，请先核对状态");
          if (active === current && !current.expired) show(current, "unknown");
          return;
        }
        if (job && active === current && !current.expired) {
          // A matching error receipt may already have arrived during the host write.
          if (current.observed) return;
          const ack = receipt(current.id);
          if (ack?.id === current.id && typeof ack.ok === "boolean") receive(ack);
          else if (Date.now() >= deadline) show(current, "unknown");
          else {
            current.until = Date.now() + receiptWait;
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
