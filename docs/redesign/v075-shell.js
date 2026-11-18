/* v0.7.5 standalone preview. No network, account credentials, or production writes. */
(() => {
  const $ = id => document.getElementById(id);
  const all = selector => [...document.querySelectorAll(selector)];
  const press = (selector, active, attr) => {
    for (const button of all(selector)) button.setAttribute("aria-pressed", String(button.dataset[attr] === active));
  };
  let toastTimer;
  const toast = message => {
    const node = $("feedback-toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
  };

  $("review-hide").addEventListener("click", () => { document.querySelector(".review-bar").hidden = true; });
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-toast]");
    if (button) toast(button.dataset.toast);
  });

  // Compensation: read-only state must never turn a query error into "none".
  const compCopy = {
    pending: ["1,000 积分待领", "11月22日 23:59 截止 · 先查询，再领取", "剩 5 天", "领取 2 个账号"],
    claimed: ["已领取 1,000 积分", "积分已到账 · 不会重复领取", "已完成", "查看记录"]
  };
  const setComp = state => {
    const active = state === "pending" || state === "claimed";
    $("compensation").hidden = !active;
    $("comp-attention").hidden = state !== "none";
    $("comp-error").hidden = state !== "error";
    press("[data-comp]", state, "comp");
    if (!active) return;
    const [amount, deadline, remaining, action] = compCopy[state];
    $("compensation").querySelector(".compensation-title span").textContent = amount;
    $("compensation").querySelector("small").textContent = deadline;
    $("comp-deadline").textContent = remaining;
    $("comp-claim").textContent = action;
    $("comp-claim").disabled = false;
  };
  all("[data-comp]").forEach(button => button.addEventListener("click", () => setComp(button.dataset.comp)));
  $("comp-claim").addEventListener("click", () => {
    if ($("comp-claim").textContent === "查看记录") {
      document.querySelector('[data-view-link="activity"]').click();
      return;
    }
    $("comp-claim").disabled = true;
    $("comp-claim").dataset.loading = "true";
    $("comp-claim").textContent = "领取中…";
    setTimeout(() => { setComp("claimed"); toast("2 个账号的补偿已领取，各 500 积分。"); }, 650);
  });
  $("comp-check").addEventListener("click", () => { setComp("pending"); toast("已重新查询补偿状态。"); });

  // Health is an information-density mode; list/rings/widgets remain display modes.
  let healthFilter = "all";
  const healthAccounts = all(".health-account");
  const filterHealth = filter => {
    healthFilter = filter;
    for (const account of healthAccounts) account.hidden = filter !== "all" && account.dataset.healthKind !== filter;
    for (const button of all("[data-health-filter]")) button.setAttribute("aria-pressed", String(button.dataset.healthFilter === filter));
    $("health-surface").querySelector(".health-empty").hidden = healthAccounts.some(account => !account.hidden);
  };
  const setHealthMode = mode => {
    const health = mode === "health";
    document.querySelector(".accounts-table").hidden = health;
    $("health-surface").hidden = !health;
    document.querySelector(".health-filter").hidden = !health;
    document.querySelector(".overview-note").hidden = health;
    document.querySelector(".health-note").hidden = !health;
    document.querySelector(".display-switch").style.visibility = health ? "hidden" : "visible";
    press("[data-health-mode]", mode, "healthMode");
    if (!health) $("batch-bar").hidden = true; else { filterHealth(healthFilter); syncBatch(); }
  };
  all("[data-health-mode]").forEach(button => button.addEventListener("click", () => setHealthMode(button.dataset.healthMode)));
  all("[data-health-filter]").forEach(button => button.addEventListener("click", () => filterHealth(button.dataset.healthFilter)));
  const syncBatch = () => {
    const selected = healthAccounts.filter(account => !account.hidden && account.querySelector(".health-check").checked);
    $("batch-bar").hidden = document.body.dataset.view !== "accounts" || !selected.length || $("health-surface").hidden;
    $("batch-count").textContent = selected.length;
  };
  all(".health-check").forEach(input => input.addEventListener("change", syncBatch));
  $("batch-clear").addEventListener("click", () => {
    healthAccounts.forEach(account => { account.querySelector(".health-check").checked = false; });
    syncBatch();
  });
  all("[data-batch]").forEach(button => button.addEventListener("click", () => toast(`批量${button.dataset.batch}：${$("batch-count").textContent} 个账号将串行执行。`)));
  all("[data-pause-account]").forEach(button => button.addEventListener("click", () => {
    const account = button.closest(".health-account");
    const name = account.dataset.healthName;
    account.dataset.healthKind = "paused";
    const state = account.querySelector(".health-state");
    state.className = "health-state idle";
    state.querySelector("strong").textContent = "已暂停";
    state.querySelector("small").textContent = "只停自动任务 · 续期与看板照常";
    account.querySelector(".health-next strong").textContent = "不自动执行";
    account.querySelector(".health-next small").textContent = "手动执行仍可使用";
    button.textContent = "恢复任务";
    button.dataset.resumeAccount = name;
    delete button.dataset.pauseAccount;
    button.addEventListener("click", () => { account.dataset.healthKind = "normal"; state.className = "health-state"; state.querySelector("strong").textContent = "正常"; button.textContent = "暂停任务"; }, { once: true });
  }));
  all("[data-resume-account]").forEach(button => button.addEventListener("click", () => {
    const account = button.closest(".health-account");
    account.dataset.healthKind = "normal";
    const state = account.querySelector(".health-state");
    state.className = "health-state";
    state.querySelector("strong").textContent = "正常";
    state.querySelector("small").textContent = "自动任务已恢复 · 续期与看板照常";
    account.querySelector(".health-next strong").textContent = "21:00";
    account.querySelector(".health-next small").textContent = "活跃 · 旅行 · 福利";
    button.textContent = "查看详情";
    button.dataset.accountOpen = "";
    button.addEventListener("click", () => selectAccount(account.dataset.healthName), { once: true });
    delete button.dataset.resumeAccount;
    filterHealth(healthFilter);
  }));

  // Origin-anchored account menu, with touch and keyboard equivalents.
  const menu = $("action-menu");
  let menuTrigger = null;
  const closeMenu = () => { menu.hidden = true; menuTrigger?.setAttribute("aria-expanded", "false"); };
  all("[data-account-menu]").forEach(button => {
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      if (menuTrigger === button && !menu.hidden) { closeMenu(); return; }
      menuTrigger = button;
      button.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      const rect = button.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 12))}px`;
      menu.style.top = `${Math.min(rect.bottom + 5, innerHeight - menu.offsetHeight - 12)}px`;
      menu.querySelector("button").focus({ preventScroll: true });
    });
  });
  menu.addEventListener("click", () => { closeMenu(); menuTrigger?.focus({ preventScroll: true }); });
  document.addEventListener("pointerdown", event => { if (!menu.hidden && !menu.contains(event.target) && event.target !== menuTrigger) closeMenu(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !menu.hidden) { closeMenu(); menuTrigger?.focus({ preventScroll: true }); } });
  window.addEventListener("resize", closeMenu);

  // Account-specific health keeps its meaning when opened from either density mode.
  const accountHealth = {
    主力号: ["国内版 · 个人 · 连登 12 天", "正常", "14:40", "0 次", "—", "21:00"],
    备用号: ["国内版 · 个人 · 连登 5 天", "登录将过期", "09:01", "0 次", "—", "22:01"],
    公司账号: ["国内版 · 企业 · 只跑续期", "限流中", "14:20", "3 次", "42:18", "明日 09:01"],
    薅毛号: ["国内版 · 个人", "连续失败", "13:50", "3 次", "—", "等待处理"],
    测试号: ["国内版 · 个人", "已暂停", "09:01", "0 次", "—", "不自动执行"],
    海外号: ["国际版 · Free · 连登 9 天", "正常", "10:30", "0 次", "—", "明日 10:30"]
  };
  const selectAccount = name => {
    const data = accountHealth[name] || accountHealth.主力号;
    $("drawer-account-name").textContent = name;
    document.querySelector(".drawer-title strong").textContent = name;
    document.querySelector(".drawer-account .avatar").textContent = name.slice(0, 1);
    $("drawer-account-meta").textContent = data[0];
    $("drawer-account-state").innerHTML = "";
    const dot = document.createElement("i");
    dot.className = `dot${data[1] === "正常" ? "" : data[1] === "限流中" ? " info" : data[1] === "已暂停" ? " idle" : " warn"}`;
    $("drawer-account-state").append(dot, document.createTextNode(data[1]));
    [$("drawer-last-success"), $("drawer-failures"), $("drawer-cooldown"), $("drawer-next-slot")].forEach((node, i) => { node.textContent = data[i + 2]; });
    document.querySelector(".domestic-only").hidden = name === "海外号";
    setBuddy(name === "海外号" ? "intl" : "ready");
  };
  window.v075SelectAccount = selectAccount;

  // Drawer tabs: click and arrow-key selection, no sideways page motion.
  const drawerTabs = all("[data-drawer-tab]");
  const drawerPanels = { overview: $("drawer-overview"), tasks: $("drawer-task-panel"), credits: $("drawer-credit-panel"), usage: $("drawer-usage-panel") };
  const selectDrawerTab = (key, focus = false) => {
    for (const button of drawerTabs) {
      const selected = button.dataset.drawerTab === key;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) {
        button.setAttribute("aria-current", "page");
        if (focus) button.focus({ preventScroll: true });
      } else button.removeAttribute("aria-current");
    }
    for (const [name, panel] of Object.entries(drawerPanels)) panel.hidden = name !== key;
  };
  drawerTabs.forEach((button, index) => {
    button.id = `drawer-tab-${button.dataset.drawerTab}`;
    drawerPanels[button.dataset.drawerTab].setAttribute("aria-labelledby", button.id);
    button.addEventListener("click", () => selectDrawerTab(button.dataset.drawerTab));
    button.addEventListener("keydown", event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = (index + (event.key === "ArrowRight" ? 1 : -1) + drawerTabs.length) % drawerTabs.length;
      selectDrawerTab(drawerTabs[next].dataset.drawerTab, true);
    });
  });
  selectDrawerTab("overview");
  const checkinCopy = {
    upstream: ["已签 +100", "上游 09:01 已签；Magpie 记录还没更新"],
    agree: ["已签 +100", "上游与 Magpie 记录一致"],
    waiting: ["未签到", "两边都没有今天的记录；Magpie 开着时会在当天自动签到"]
  };
  all("[data-checkin]").forEach(button => button.addEventListener("click", () => {
    const [status, source] = checkinCopy[button.dataset.checkin];
    $("checkin-status").textContent = status;
    $("checkin-status").classList.toggle("waiting", button.dataset.checkin === "waiting");
    $("checkin-source").textContent = source;
    press("[data-checkin]", button.dataset.checkin, "checkin");
  }));

  // Buddy energy is an irreversible spend, so this one action keeps a confirmation.
  const buddyStates = {
    ready: [20, "可开 2 个 · 每个 10 能量", "开盲盒", false],
    empty: [8, "还差 2 能量可开 1 个 · 随活跃和任务积累", "能量不足", true],
    travel: [20, "猫猫正在旅行 · 归来领奖后可开", "等旅行归来", true],
    intl: [0, "国际版没有成长能量和 Buddy 盲盒", "不适用", true]
  };
  let buddyState = "ready";
  const setBuddy = state => {
    buddyState = state;
    const [energy, description, action, disabled] = buddyStates[state];
    $("buddy-energy").textContent = energy;
    $("buddy-description").textContent = description;
    $("buddy-open").textContent = action;
    $("buddy-open").disabled = disabled;
    $("buddy-open").title = disabled ? description : "";
    $("buddy-result").textContent = "";
    press("[data-buddy]", state, "buddy");
  };
  all("[data-buddy]").forEach(button => button.addEventListener("click", () => setBuddy(button.dataset.buddy)));
  $("buddy-open").addEventListener("click", () => {
    if (buddyState !== "ready") return;
    $("buddy-dialog-cost").textContent = "20";
    $("buddy-dialog-energy").textContent = "20";
    $("buddy-dialog-remaining").textContent = "0";
    $("buddy-dialog").showModal();
    $("buddy-cancel").focus({ preventScroll: true });
  });
  $("buddy-cancel").addEventListener("click", () => $("buddy-dialog").close());
  $("buddy-confirm").addEventListener("click", () => {
    $("buddy-dialog").close();
    $("buddy-energy").textContent = "0";
    $("buddy-description").textContent = "能量已用完 · 等活跃与任务继续积累";
    $("buddy-open").textContent = "能量不足";
    $("buddy-open").disabled = true;
    $("buddy-open").title = "成长能量不足，暂时不能开盒";
    $("buddy-result").textContent = "已开启：薄荷团子、团子";
    buddyState = "empty";
    press("[data-buddy]", "empty", "buddy");
    buddyStates.empty[0] = 0;
  });
  $("buddy-dialog").addEventListener("click", event => { if (event.target === $("buddy-dialog")) $("buddy-dialog").close(); });

  // Expert parsing: demonstrate the transition without hiding unadaptable tasks.
  let parsed = false;
  $("expert-toggle").addEventListener("click", () => {
    parsed = !parsed;
    $("expert-status").textContent = parsed ? "自动识别" : "待适配";
    $("expert-source").textContent = parsed ? "从 jump_url 解析到 expertId · 走正常接取、上报与领奖" : "jump_url 未解析到 expertId · 不会硬报进度";
    $("expert-toggle").textContent = parsed ? "还原状态" : "查看解析";
  });

  // Queue states and channel filtering do not move the user's scroll position.
  const setQueue = state => {
    const rows = all(".queue-account");
    rows[0].hidden = state === "idle";
    rows[1].hidden = state === "idle";
    rows[2].hidden = state === "idle";
    rows[1].querySelector(".queue-state").textContent = state === "parallel" ? "执行中" : "第 2 位";
    rows[1].querySelector(".queue-state").classList.toggle("go", state === "parallel");
    rows[1].querySelector(".queue-progress small").textContent = state === "parallel" ? "连登已亮灯 · 准备领奖" : "等前一个账号完成";
    rows[1].querySelector(".queue-track").innerHTML = state === "parallel" ? '<span style="--progress:35%"></span>' : "";
    $("queue-count").textContent = state === "idle" ? "0" : "3";
    press("[data-queue-state]", state, "queueState");
  };
  all("[data-queue-state]").forEach(button => button.addEventListener("click", () => setQueue(button.dataset.queueState)));

  let logChannel = "all";
  const filterLogs = () => {
    const account = $("log-account-filter").value;
    let count = 0;
    for (const line of all(".log-line")) {
      line.hidden = (logChannel !== "all" && line.dataset.logChannel !== logChannel) || (account !== "all" && line.dataset.logAccount !== account);
      if (!line.hidden) count++;
    }
    $("log-count").textContent = `${count} 条`;
  };
  all("[data-log-channel]").forEach(button => button.addEventListener("click", () => {
    logChannel = button.dataset.logChannel;
    press("[data-log-channel]", logChannel, "logChannel");
    filterLogs();
  }));
  $("log-account-filter").addEventListener("change", filterLogs);

  all("[data-concurrency]").forEach(button => button.addEventListener("click", () => {
    press("[data-concurrency]", button.dataset.concurrency, "concurrency");
    document.querySelector(".execution-facts > div:nth-child(2) dd").textContent = button.dataset.concurrency;
  }));
  $("buddy-auto").addEventListener("click", () => {
    const enabled = $("buddy-auto").getAttribute("aria-checked") !== "true";
    $("buddy-auto").setAttribute("aria-checked", String(enabled));
    $("buddy-auto-state").textContent = enabled ? "当前开启；旅行领奖后、派出前自动开盒。" : "当前关闭；手动开盒不受影响。";
  });
  const drawerPause = $("drawer-pause");
  drawerPause.addEventListener("click", () => {
    $("drawer-pause-note").hidden = false;
    drawerPause.hidden = true;
    $("drawer-account-state").lastChild.textContent = "已暂停";
  });
  document.querySelector("[data-drawer-resume]").addEventListener("click", () => {
    $("drawer-pause-note").hidden = true;
    drawerPause.hidden = false;
    $("drawer-account-state").lastChild.textContent = "正常";
  });

  // The mock countdown represents live service state; it never drives a timer itself.
  let cooldownSeconds = 42 * 60 + 18;
  setInterval(() => {
    cooldownSeconds = Math.max(0, cooldownSeconds - 1);
    $("cooldown").textContent = `${String(Math.floor(cooldownSeconds / 60)).padStart(2, "0")}:${String(cooldownSeconds % 60).padStart(2, "0")}`;
  }, 1000);
})();
