const STORAGE_KEYS = {
  TOKEN: "api_token",
  TOKEN_HEADER_NAME: "api_token_header_name",
  ACCOUNTS: "api_accounts",
  ACTIVE_ACCOUNT_ID: "api_active_account_id",
  FEATURE_TASK_ACCOUNT_ID: "feature_task_account_id",
  FEATURE_REDPACKET_ACCOUNT_ID: "feature_redpacket_account_id",
  FEATURE_DAILY_EDITOR_ACCOUNT_ID: "feature_daily_editor_account_id",
  FEATURE_TASK_ACCOUNT_IDS: "feature_task_account_ids",
  FEATURE_REDPACKET_ACCOUNT_IDS: "feature_redpacket_account_ids",
  FEATURE_DAILY_EDITOR_ACCOUNT_IDS: "feature_daily_editor_account_ids",
  FEATURE_PET_ACCOUNT_ID: "feature_pet_account_id",
  FEATURE_PET_ACCOUNT_IDS: "feature_pet_account_ids",
  TASKS: "api_tasks",
  LOGS: "api_call_logs",
  AUTO_RED_PACKET: "auto_red_packet_enabled",
  AUTO_RED_PACKET_WS_ENABLED: "auto_red_packet_ws_enabled",
  AUTO_RED_PACKET_WS_URL: "auto_red_packet_ws_url",
  AUTO_RED_PACKET_API_BASE_URL: "auto_red_packet_api_base_url",
  WS_MESSAGES: "ws_messages",
  RED_PACKET_GRAB_LOGS: "red_packet_grab_logs",
  AUTO_RED_PACKET_CLAIMED_IDS: "auto_red_packet_claimed_ids",
  AUTO_DAILY_SIGN_IN_ENABLED: "auto_daily_sign_in_enabled",
  AUTO_DAILY_CHAT_ENABLED: "auto_daily_chat_enabled",
  AUTO_DAILY_LAST_SIGN_IN_DAY: "auto_daily_last_sign_in_day",
  AUTO_DAILY_LAST_CHAT_ROUTINE_DAY: "auto_daily_last_chat_routine_day",
  AUTO_DAILY_CHAT_STATE: "auto_daily_chat_state",
  AUTO_DAILY_CHAT_CLIENT: "auto_daily_chat_client",
  AUTO_PET_CARE_INTERVAL_MINUTES: "auto_pet_care_interval_minutes"
};

const MAX_RED_PACKET_IDS = 200;

function newAccountId() {
  return `acc_${Date.now()}_${1000 + Math.floor(Math.random() * 9000)}`;
}

function normalizeAccount(raw, index = 0) {
  const id = String(raw?.id || "").trim() || newAccountId();
  let claimed = [];
  if (Array.isArray(raw?.redPacketClaimedIds)) {
    claimed = raw.redPacketClaimedIds.map((x) => String(x));
  }
  if (claimed.length > MAX_RED_PACKET_IDS) {
    claimed = claimed.slice(0, MAX_RED_PACKET_IDS);
  }
  return {
    id,
    name: String(raw?.name || `账号${index + 1}`).trim() || `账号${index + 1}`,
    token: String(raw?.token || "").trim(),
    tokenHeaderName: String(raw?.tokenHeaderName || "").trim(),
    redPacketClaimedIds: claimed,
    autoDailySignInEnabled: raw?.autoDailySignInEnabled === true,
    autoDailyChatEnabled: raw?.autoDailyChatEnabled === true,
    autoPetCareEnabled: raw?.autoPetCareEnabled === true,
    autoDailyChatClient: String(raw?.autoDailyChatClient || "").trim(),
    dailyLastSignInDay: String(raw?.dailyLastSignInDay || "").trim(),
    dailyLastChatRoutineDay: String(raw?.dailyLastChatRoutineDay || "").trim(),
    dailyChatState:
      raw?.dailyChatState && typeof raw.dailyChatState === "object" ? raw.dailyChatState : null,
    petId: String(raw?.petId ?? "").trim()
  };
}

async function saveAccountsToStorage(accounts, activeAccountId) {
  const norm = accounts.map((a, i) => normalizeAccount(a, i));
  let activeId = String(activeAccountId || "").trim();
  if (!norm.some((a) => a.id === activeId)) {
    activeId = norm[0] ? norm[0].id : "";
  }
  const active = norm.find((a) => a.id === activeId) || norm[0];
  const patch = {
    [STORAGE_KEYS.ACCOUNTS]: norm,
    [STORAGE_KEYS.ACTIVE_ACCOUNT_ID]: activeId
  };
  if (active) {
    patch[STORAGE_KEYS.TOKEN] = active.token;
    patch[STORAGE_KEYS.TOKEN_HEADER_NAME] = active.tokenHeaderName;
  } else {
    patch[STORAGE_KEYS.TOKEN] = "";
    patch[STORAGE_KEYS.TOKEN_HEADER_NAME] = "";
  }
  await chrome.storage.local.set(patch);
}

async function migrateAndLoadAccounts() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.ACCOUNTS,
    STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
    STORAGE_KEYS.TOKEN,
    STORAGE_KEYS.TOKEN_HEADER_NAME,
    STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS,
    STORAGE_KEYS.AUTO_DAILY_SIGN_IN_ENABLED,
    STORAGE_KEYS.AUTO_DAILY_CHAT_ENABLED,
    STORAGE_KEYS.AUTO_DAILY_LAST_SIGN_IN_DAY,
    STORAGE_KEYS.AUTO_DAILY_LAST_CHAT_ROUTINE_DAY,
    STORAGE_KEYS.AUTO_DAILY_CHAT_STATE,
    STORAGE_KEYS.AUTO_DAILY_CHAT_CLIENT
  ]);

  let rawList = data[STORAGE_KEYS.ACCOUNTS];
  let accounts = Array.isArray(rawList) ? rawList.map((a, i) => normalizeAccount(a, i)) : [];
  let activeId = String(data[STORAGE_KEYS.ACTIVE_ACCOUNT_ID] || "").trim();

  if (accounts.length === 0) {
    const legacyToken = String(data[STORAGE_KEYS.TOKEN] || "").trim();
    if (legacyToken) {
      const id = newAccountId();
      accounts = [
        normalizeAccount(
          {
            id,
            name: "账号1",
            token: legacyToken,
            tokenHeaderName: String(data[STORAGE_KEYS.TOKEN_HEADER_NAME] || "").trim(),
            redPacketClaimedIds: Array.isArray(data[STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS])
              ? data[STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS]
              : [],
            autoDailySignInEnabled: data[STORAGE_KEYS.AUTO_DAILY_SIGN_IN_ENABLED] === true,
            autoDailyChatEnabled: data[STORAGE_KEYS.AUTO_DAILY_CHAT_ENABLED] === true,
            dailyLastSignInDay: String(data[STORAGE_KEYS.AUTO_DAILY_LAST_SIGN_IN_DAY] || "").trim(),
            dailyLastChatRoutineDay: String(
              data[STORAGE_KEYS.AUTO_DAILY_LAST_CHAT_ROUTINE_DAY] || ""
            ).trim(),
            dailyChatState: data[STORAGE_KEYS.AUTO_DAILY_CHAT_STATE] || null,
            autoDailyChatClient: String(data[STORAGE_KEYS.AUTO_DAILY_CHAT_CLIENT] || "").trim()
          },
          0
        )
      ];
      activeId = id;
      await saveAccountsToStorage(accounts, activeId);
    }
  } else if (activeId && !accounts.some((a) => a.id === activeId)) {
    activeId = accounts[0].id;
    await saveAccountsToStorage(accounts, activeId);
  } else if (!activeId && accounts.length) {
    activeId = accounts[0].id;
    await saveAccountsToStorage(accounts, activeId);
  }

  return { accounts, activeAccountId: activeId };
}

function getActiveFromBundle(bundle) {
  const { accounts, activeAccountId } = bundle;
  if (!accounts.length) {
    return null;
  }
  return accounts.find((a) => a.id === activeAccountId) || accounts[0];
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function classifyMessageBody(contentStr) {
  if (contentStr == null) return "【消息】";
  const body = String(contentStr);
  if (/\[redpacket\]\s*[\s\S]*?\[\/redpacket\]/i.test(body)) {
    return "【红包】";
  }
  try {
    const j = JSON.parse(body);
    if (j && j.msgType === "redPacket") {
      return "【红包】";
    }
  } catch {
    /* ignore */
  }
  if (
    /<img[\s\S]*?>/i.test(body) ||
    /!\[[^\]]*\]\([^)]+\)/.test(body) ||
    /\[图片\]/.test(body) ||
    /https?:\/\/[^\s"'<>]+\.(png|jpe?g|gif|webp)(\?[^\s"'<>]*)?/i.test(body) ||
    /fishpi\.cn\/gen/i.test(body)
  ) {
    return "【图片】";
  }
  const stripped = body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "【消息】";
  return stripped.length > 220 ? `${stripped.slice(0, 220)}…` : stripped;
}

function pickSenderName(parsed, messageObj) {
  const s = messageObj?.sender;
  return (
    s?.userName ||
    s?.name ||
    s?.nickname ||
    messageObj?.userName ||
    messageObj?.userNickname ||
    parsed?.userName ||
    parsed?.userNickname ||
    parsed?.nickname ||
    "?"
  );
}

function formatChatroomDisplay(rawText) {
  const raw = String(rawText || "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      name: "?",
      line: /\[redpacket\]/i.test(raw) ? "【红包】" : raw.slice(0, 240)
    };
  }

  if (parsed.type === "barrager") {
    const name = parsed.userNickname || parsed.userName || "?";
    return { name, line: classifyMessageBody(parsed.barragerContent || "") };
  }

  const nested =
    parsed.type === "chat"
      ? parsed.data?.message
      : parsed.data?.message || parsed.message;

  if (nested && (nested.content != null || nested.sender)) {
    const name = pickSenderName(parsed, nested);
    const content =
      typeof nested.content === "string"
        ? nested.content
        : nested.content != null
          ? JSON.stringify(nested.content)
          : "";
    return { name, line: classifyMessageBody(content) };
  }

  if (
    (parsed.type === "msg" || parsed.oId) &&
    typeof parsed.content === "string"
  ) {
    const name =
      pickSenderName(parsed, parsed) ||
      parsed.userName ||
      parsed.userNickname ||
      parsed.nickname ||
      "?";
    return { name, line: classifyMessageBody(parsed.content) };
  }

  if (/\[redpacket\]/i.test(raw)) {
    return { name: "?", line: "【红包】" };
  }

  return { name: "?", line: "【消息】" };
}

const tokenInput = document.getElementById("tokenInput");
const tokenHeaderInput = document.getElementById("tokenHeaderInput");
const saveTokenBtn = document.getElementById("saveTokenBtn");
const accountSelect = document.getElementById("accountSelect");
const accountNameInput = document.getElementById("accountNameInput");
const addAccountBtn = document.getElementById("addAccountBtn");
const removeAccountBtn = document.getElementById("removeAccountBtn");
const taskFeatureAccounts = document.getElementById("taskFeatureAccounts");
const redPacketFeatureAccounts = document.getElementById("redPacketFeatureAccounts");
const dailyFeatureAccounts = document.getElementById("dailyFeatureAccounts");
const petFeatureAccounts = document.getElementById("petFeatureAccounts");
const taskNameInput = document.getElementById("taskNameInput");
const taskUrlInput = document.getElementById("taskUrlInput");
const taskMethodInput = document.getElementById("taskMethodInput");
const taskIntervalInput = document.getElementById("taskIntervalInput");
const addTaskBtn = document.getElementById("addTaskBtn");
const taskList = document.getElementById("taskList");
const statusEl = document.getElementById("status");
const usePageTokenBtn = document.getElementById("usePageTokenBtn");
const accountPetIdInput = document.getElementById("accountPetIdInput");
const fetchPetIdBtn = document.getElementById("fetchPetIdBtn");
const logsAccountFilter = document.getElementById("logsAccountFilter");
const refreshLogsBtn = document.getElementById("refreshLogsBtn");
const logsList = document.getElementById("logsList");
const wsMessagesList = document.getElementById("wsMessagesList");
const autoRedPacketInput = document.getElementById("autoRedPacketInput");
const wsAutoGrabInput = document.getElementById("wsAutoGrabInput");
const wsUrlInput = document.getElementById("wsUrlInput");
const apiBaseUrlInput = document.getElementById("apiBaseUrlInput");
const saveAutoGrabSettingsBtn = document.getElementById("saveAutoGrabSettingsBtn");
const refreshWsMessagesBtn = document.getElementById("refreshWsMessagesBtn");
const configTabBtn = document.getElementById("configTabBtn");
const logsTabBtn = document.getElementById("logsTabBtn");
const configPanel = document.getElementById("configPanel");
const logsPanel = document.getElementById("logsPanel");
const dailyRedPacketStats = document.getElementById("dailyRedPacketStats");
const redPacketGrabLogsList = document.getElementById("redPacketGrabLogsList");
const autoDailySignInInput = document.getElementById("autoDailySignInInput");
const autoDailyChatInput = document.getElementById("autoDailyChatInput");
const autoDailyChatClientInput = document.getElementById("autoDailyChatClientInput");
const autoPetCareInput = document.getElementById("autoPetCareInput");
const runDailyRoutineNowBtn = document.getElementById("runDailyRoutineNowBtn");
const runPetCareNowBtn = document.getElementById("runPetCareNowBtn");
const petCareIntervalSelect = document.getElementById("petCareIntervalSelect");
const clearAllLogsBtn = document.getElementById("clearAllLogsBtn");

function getLogsAccountFilterValue() {
  return logsAccountFilter?.value || "__all";
}

function filterEntriesByAccount(entries, filterId) {
  const list = Array.isArray(entries) ? entries : [];
  if (!filterId || filterId === "__all") {
    return list;
  }
  if (filterId === "__unassigned") {
    return list.filter((e) => !String(e.accountId || "").trim());
  }
  return list.filter((e) => String(e.accountId || "") === filterId);
}

function populateLogsAccountFilter(accounts) {
  if (!logsAccountFilter) {
    return;
  }
  const prev = logsAccountFilter.value;
  logsAccountFilter.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "__all";
  optAll.textContent = "全部账号";
  logsAccountFilter.appendChild(optAll);
  const optUn = document.createElement("option");
  optUn.value = "__unassigned";
  optUn.textContent = "未标注账号（旧记录）";
  logsAccountFilter.appendChild(optUn);
  for (const a of accounts || []) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = a.name;
    logsAccountFilter.appendChild(o);
  }
  const ok = [...logsAccountFilter.options].some((x) => x.value === prev);
  logsAccountFilter.value = ok ? prev : "__all";
}

function localDayKey(ts) {
  const d = new Date(Number(ts) || 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function renderDailyStats(grabLogs) {
  if (!dailyRedPacketStats) return;
  dailyRedPacketStats.innerHTML = "";

  const filt = getLogsAccountFilterValue();
  const logs = filterEntriesByAccount(Array.isArray(grabLogs) ? grabLogs : [], filt);
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "task-meta";
    empty.textContent = "暂无统计数据";
    dailyRedPacketStats.appendChild(empty);
    return;
  }

  const byDay = new Map();
  for (const log of logs) {
    const day = localDayKey(log.createdAt);
    if (!byDay.has(day)) {
      byDay.set(day, { attempts: 0, wins: 0, points: 0 });
    }
    const agg = byDay.get(day);
    agg.attempts += 1;
    if (log.success) {
      agg.wins += 1;
      const pts = Number(log.amount);
      if (Number.isFinite(pts)) {
        agg.points += pts;
      }
    }
  }

  const days = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const day of days) {
    const { attempts, wins, points } = byDay.get(day);
    const row = document.createElement("div");
    row.className = "stats-row";
    row.textContent = `${day}：抢到 ${wins} 个红包，合计 +${points} 积分（请求 ${attempts} 次）`;
    dailyRedPacketStats.appendChild(row);
  }
}

function renderGrabLogs(grabLogs) {
  if (!redPacketGrabLogsList) return;
  redPacketGrabLogsList.innerHTML = "";

  const filt = getLogsAccountFilterValue();
  const logs = filterEntriesByAccount(Array.isArray(grabLogs) ? grabLogs : [], filt);
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "task-meta";
    empty.textContent = "暂无抢红包记录";
    redPacketGrabLogsList.appendChild(empty);
    return;
  }

  logs.forEach((log) => {
    const item = document.createElement("div");
    item.className = "log-item";
    const createdAt = new Date(log.createdAt).toLocaleString();
    const pts =
      log.success &&
      log.amount != null &&
      Number.isFinite(Number(log.amount))
        ? Number(log.amount)
        : null;
    const headline =
      log.success && pts != null
        ? `抢到 ${pts} 积分`
        : log.success
          ? "抢红包成功（积分未解析）"
          : "未抢到或失败";
    const acct =
      log.accountName || log.accountId
        ? `账号：${escapeHtml(log.accountName || log.accountId || "")}`
        : "";
    item.innerHTML = `
      <div class="task-title">${log.success ? "✅" : "❌"} ${headline}</div>
      <div class="task-meta">${acct ? `${acct} · ` : ""}红包 ID：${log.redPacketId || "-"} · ${createdAt}</div>
      <div class="task-meta">HTTP ${log.statusCode ?? "-"} · API code ${log.apiCode ?? "-"}</div>
      <div class="task-meta">${escapeHtml((log.message || "").slice(0, 240))}</div>
    `;
    redPacketGrabLogsList.appendChild(item);
  });
}

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b00020" : "#1f6f2d";
}

function switchTab(tabName) {
  const isConfig = tabName === "config";
  configTabBtn.classList.toggle("active", isConfig);
  logsTabBtn.classList.toggle("active", !isConfig);
  configPanel.classList.toggle("active", isConfig);
  logsPanel.classList.toggle("active", !isConfig);
}

function initCollapseSections() {
  document.body.addEventListener("click", (e) => {
    const header = e.target.closest(".collapse-header");
    if (!header) return;
    const sec = header.closest(".collapse-section");
    if (!sec) return;
    const expanded = sec.classList.toggle("expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
  });
}

function renderTasks(tasks) {
  taskList.innerHTML = "";

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "task-meta";
    empty.textContent = "暂无任务";
    taskList.appendChild(empty);
    return;
  }

  tasks.forEach((task) => {
    const item = document.createElement("div");
    item.className = "task-item";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = task.name;

    const meta = document.createElement("div");
    meta.className = "task-meta";
    const intervalSeconds = Number(task.intervalSeconds || task.intervalMinutes * 60 || 0);
    const method = (task.method || "GET").toUpperCase();
    meta.textContent = `${method} | 每 ${intervalSeconds} 秒调用: ${task.url}`;

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "删除";
    removeBtn.style.marginTop = "6px";
    removeBtn.addEventListener("click", () => removeTask(task.id));

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(removeBtn);
    taskList.appendChild(item);
  });
}

function renderLogs(logs) {
  logsList.innerHTML = "";

  const filt = getLogsAccountFilterValue();
  const filtered = filterEntriesByAccount(Array.isArray(logs) ? logs : [], filt);
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "task-meta";
    empty.textContent = "暂无调用记录";
    logsList.appendChild(empty);
    return;
  }

  filtered.forEach((log) => {
    const item = document.createElement("div");
    item.className = "log-item";
    const createdAt = new Date(log.createdAt).toLocaleString();

    const acct =
      log.accountName || log.accountId
        ? `<div class="task-meta">账号：${escapeHtml(log.accountName || log.accountId || "")}</div>`
        : "";
    const urlRaw = String(log.url || "");
    const msgRaw = String(log.message || "");
    const msgBlock = msgRaw.trim()
      ? `<div class="log-api-msg">${escapeHtml(msgRaw)}</div>`
      : "";
    const urlBlock = urlRaw.trim()
      ? `<div class="log-api-url">${escapeHtml(urlRaw)}</div>`
      : "";
    item.innerHTML = `
      <div class="task-title">${log.success ? "✅" : "❌"} ${escapeHtml(String(log.taskName || "未知任务"))}</div>
      ${acct}
      <div class="task-meta">${createdAt}</div>
      <div class="task-meta">方法: ${escapeHtml(String(log.method || "GET"))}</div>
      <div class="task-meta">状态: ${log.statusCode ?? "-"}</div>
      ${urlBlock}
      ${msgBlock}
    `;

    logsList.appendChild(item);
  });
}

function renderWsMessages(messages) {
  wsMessagesList.innerHTML = "";

  const filt = getLogsAccountFilterValue();
  const raw = filterEntriesByAccount(Array.isArray(messages) ? messages : [], filt);
  if (!raw.length) {
    const empty = document.createElement("div");
    empty.className = "task-meta";
    empty.textContent = "暂无聊天室 WS 记录";
    wsMessagesList.appendChild(empty);
    return;
  }

  raw.forEach((item) => {
    const { name, line } = formatChatroomDisplay(item.message);
    const row = document.createElement("div");
    row.className = "chat-log-item";
    const createdAt = new Date(item.createdAt).toLocaleString();
    const who = escapeHtml(name);
    const what = escapeHtml(line);
    const acctTag = item.accountName
      ? `<span class="chat-log-type-tag">${escapeHtml(item.accountName)}</span>`
      : "";
    row.innerHTML = `
      <div class="chat-log-header">
        <span class="chat-log-time">${createdAt}</span>
        ${acctTag}
      </div>
      <div class="chat-log-content"><span class="chat-log-nickname">${who}</span>：${what}</div>
    `;
    wsMessagesList.appendChild(row);
  });
}

async function fetchCurrentPageToken() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      return "";
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => localStorage.getItem("tokenValue")
    });

    return result?.[0]?.result || "";
  } catch (error) {
    console.error("读取当前网页 tokenValue 失败:", error);
    return "";
  }
}

function normalizeFeatureAccountIdsArray(rawArr, legacyId, activeAccountId, accounts) {
  if (Array.isArray(rawArr) && rawArr.length === 0) {
    return [];
  }
  let ids = Array.isArray(rawArr)
    ? rawArr.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  ids = [...new Set(ids)].filter((id) => accounts.some((a) => a.id === id));
  if (!ids.length) {
    const leg = String(legacyId || "").trim();
    if (leg && accounts.some((a) => a.id === leg)) {
      ids = [leg];
    }
  }
  if (!ids.length && activeAccountId && accounts.some((a) => a.id === activeAccountId)) {
    ids = [activeAccountId];
  }
  if (!ids.length && accounts[0]) {
    ids = [accounts[0].id];
  }
  return ids;
}

function getCheckedIdsFromContainer(container) {
  if (!container) {
    return [];
  }
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
}

function renderFeatureAccountChecks(container, accounts, selectedIds, storageKey) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const sel = new Set(selectedIds);
  const list = Array.isArray(accounts) ? accounts : [];
  list.forEach((a) => {
    const lab = document.createElement("label");
    lab.className = "feat-acc-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = a.id;
    cb.checked = sel.has(a.id);
    cb.addEventListener("change", async () => {
      let ids = getCheckedIdsFromContainer(container);
      ids = [...new Set(ids)].filter((id) => list.some((a) => a.id === id));
      await chrome.storage.local.set({ [storageKey]: ids });
      showStatus(ids.length ? "已保存账号选择" : "已清空该功能的账号选择（对应功能将不执行）");
      if (storageKey === STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS) {
        syncDailyFieldsFromFirstChecked(list);
      }
      if (storageKey === STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS) {
        syncPetCareFieldsFromFirstChecked(list);
      }
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(` ${a.name}`));
    container.appendChild(lab);
  });
}

function syncDailyFieldsFromFirstChecked(accounts) {
  const ids = getCheckedIdsFromContainer(dailyFeatureAccounts);
  const firstId = ids[0];
  const acc = accounts.find((x) => x.id === firstId);
  applyDailyEditorInputs(acc || null);
}

function applyPetCareInputs(account) {
  if (!autoPetCareInput) {
    return;
  }
  if (!account) {
    autoPetCareInput.checked = false;
    return;
  }
  autoPetCareInput.checked = account.autoPetCareEnabled === true;
}

function syncPetCareFieldsFromFirstChecked(accounts) {
  const ids = getCheckedIdsFromContainer(petFeatureAccounts);
  const firstId = ids[0];
  const acc = accounts.find((x) => x.id === firstId);
  applyPetCareInputs(acc || null);
}

function fillAccountDropdown(selectEl, accounts, selectedId) {
  if (!selectEl) {
    return;
  }
  selectEl.innerHTML = "";
  const list = Array.isArray(accounts) ? accounts : [];
  for (const a of list) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.name;
    selectEl.appendChild(opt);
  }
  const pick = selectedId && list.some((x) => x.id === selectedId) ? selectedId : list[0]?.id || "";
  selectEl.value = pick;
}

function applyDailyEditorInputs(account) {
  if (!account) {
    autoDailySignInInput.checked = false;
    autoDailyChatInput.checked = false;
    autoDailyChatClientInput.value = "";
    return;
  }
  autoDailySignInInput.checked = account.autoDailySignInEnabled === true;
  autoDailyChatInput.checked = account.autoDailyChatEnabled === true;
  autoDailyChatClientInput.value = account.autoDailyChatClient || "";
}

function renderAccountSelect(accounts, activeId) {
  fillAccountDropdown(accountSelect, accounts, activeId);
}

async function loadData() {
  const bundle = await migrateAndLoadAccounts();
  const { accounts, activeAccountId } = bundle;
  renderAccountSelect(accounts, activeAccountId);
  populateLogsAccountFilter(accounts);
  const active = getActiveFromBundle(bundle);
  if (active) {
    tokenInput.value = active.token;
    tokenHeaderInput.value = active.tokenHeaderName;
    accountNameInput.value = active.name;
    if (accountPetIdInput) {
      accountPetIdInput.value = active.petId || "";
    }
  } else {
    tokenInput.value = "";
    tokenHeaderInput.value = "";
    accountNameInput.value = "";
    if (accountPetIdInput) {
      accountPetIdInput.value = "";
    }
  }

  const featData = await chrome.storage.local.get([
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_ID,
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_ID,
    STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_ID,
    STORAGE_KEYS.FEATURE_PET_ACCOUNT_ID
  ]);

  const taskIds = normalizeFeatureAccountIdsArray(
    featData[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS],
    featData[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_ID],
    activeAccountId,
    accounts
  );
  const rpIds = normalizeFeatureAccountIdsArray(
    featData[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS],
    featData[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_ID],
    activeAccountId,
    accounts
  );
  const dailyIds = normalizeFeatureAccountIdsArray(
    featData[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS],
    featData[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_ID],
    activeAccountId,
    accounts
  );
  const petIds = normalizeFeatureAccountIdsArray(
    featData[STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS],
    featData[STORAGE_KEYS.FEATURE_PET_ACCOUNT_ID],
    activeAccountId,
    accounts
  );

  const migratePatch = {};
  if (
    JSON.stringify(featData[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS] || []) !==
    JSON.stringify(taskIds)
  ) {
    migratePatch[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS] = taskIds;
  }
  if (
    JSON.stringify(featData[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS] || []) !==
    JSON.stringify(rpIds)
  ) {
    migratePatch[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS] = rpIds;
  }
  if (
    JSON.stringify(featData[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS] || []) !==
    JSON.stringify(dailyIds)
  ) {
    migratePatch[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS] = dailyIds;
  }
  if (JSON.stringify(featData[STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS] || []) !== JSON.stringify(petIds)) {
    migratePatch[STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS] = petIds;
  }
  if (Object.keys(migratePatch).length) {
    await chrome.storage.local.set(migratePatch);
  }

  renderFeatureAccountChecks(
    taskFeatureAccounts,
    accounts,
    taskIds,
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS
  );
  renderFeatureAccountChecks(
    redPacketFeatureAccounts,
    accounts,
    rpIds,
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS
  );
  renderFeatureAccountChecks(
    dailyFeatureAccounts,
    accounts,
    dailyIds,
    STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS
  );
  renderFeatureAccountChecks(
    petFeatureAccounts,
    accounts,
    petIds,
    STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS
  );
  syncDailyFieldsFromFirstChecked(accounts);
  syncPetCareFieldsFromFirstChecked(accounts);

  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TASKS,
    STORAGE_KEYS.LOGS,
    STORAGE_KEYS.WS_MESSAGES,
    STORAGE_KEYS.AUTO_RED_PACKET,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_URL,
    STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL,
    STORAGE_KEYS.RED_PACKET_GRAB_LOGS,
    STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES
  ]);

  const tasks = data[STORAGE_KEYS.TASKS] || [];
  const logs = data[STORAGE_KEYS.LOGS] || [];
  const wsMessages = data[STORAGE_KEYS.WS_MESSAGES] || [];
  const grabLogs = data[STORAGE_KEYS.RED_PACKET_GRAB_LOGS] || [];
  autoRedPacketInput.checked = data[STORAGE_KEYS.AUTO_RED_PACKET] !== false;
  wsAutoGrabInput.checked = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED] !== false;
  wsUrlInput.value = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] || "wss://api.yucoder.cn/ws/?token={token}";
  apiBaseUrlInput.value = data[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL] || "https://api.yucoder.cn";
  if (petCareIntervalSelect) {
    const petInterval = Number(data[STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES]);
    const v = Number.isFinite(petInterval)
      ? Math.min(24 * 60, Math.max(5, Math.round(petInterval)))
      : 60;
    const ok = [...petCareIntervalSelect.options].some((o) => Number(o.value) === v);
    petCareIntervalSelect.value = ok ? String(v) : "60";
  }
  renderTasks(tasks);
  renderLogs(logs);
  renderDailyStats(grabLogs);
  renderGrabLogs(grabLogs);
  renderWsMessages(wsMessages);
}

saveTokenBtn.addEventListener("click", async () => {
  let bundle = await migrateAndLoadAccounts();
  let { accounts, activeAccountId } = bundle;
  let active = getActiveFromBundle(bundle);
  if (!active) {
    const id = newAccountId();
    active = normalizeAccount(
      {
        id,
        name: accountNameInput.value.trim() || "账号1",
        token: tokenInput.value.trim(),
        tokenHeaderName: tokenHeaderInput.value.trim(),
        petId: accountPetIdInput ? accountPetIdInput.value.trim() : ""
      },
      0
    );
    accounts = [active];
    activeAccountId = id;
  } else {
    const tid = active.id;
    const nm = accountNameInput.value.trim() || active.name;
    accounts = accounts.map((a) =>
      a.id === tid
        ? {
            ...a,
            token: tokenInput.value.trim(),
            tokenHeaderName: tokenHeaderInput.value.trim(),
            name: nm,
            petId: accountPetIdInput ? accountPetIdInput.value.trim() : ""
          }
        : a
    );
  }
  await saveAccountsToStorage(accounts, activeAccountId);
  showStatus("已保存当前账号（名称、Token、宠物 ID）");
});

if (fetchPetIdBtn && accountPetIdInput) {
  fetchPetIdBtn.addEventListener("click", async () => {
    const aid = accountSelect.value;
    if (!aid) {
      showStatus("请先选择账号", true);
      return;
    }
    fetchPetIdBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "FETCH_ACCOUNT_PET_ID",
        accountId: aid,
        token: tokenInput?.value?.trim() || "",
        tokenHeaderName: tokenHeaderInput?.value?.trim() || ""
      });
      if (chrome.runtime.lastError) {
        showStatus(chrome.runtime.lastError.message || "后台通信失败", true);
        return;
      }
      if (!resp?.ok) {
        showStatus(resp?.error || "获取失败", true);
        return;
      }
      const pid = String(resp.petId ?? "");
      accountPetIdInput.value = pid;
      showStatus(`已填入宠物 ID：${pid}，请点击「保存账号资料」写入存储`);
    } catch (e) {
      showStatus(String(e), true);
    } finally {
      fetchPetIdBtn.disabled = false;
    }
  });
}

usePageTokenBtn.addEventListener("click", async () => {
  const tokenValue = await fetchCurrentPageToken();
  if (!tokenValue) {
    showStatus("当前页无法读取 tokenValue", true);
    return;
  }

  tokenInput.value = tokenValue;
  showStatus("已填入 Token，请点击「保存账号资料」");
});

accountSelect.addEventListener("change", async () => {
  const bundle = await migrateAndLoadAccounts();
  await saveAccountsToStorage(bundle.accounts, accountSelect.value);
  await loadData();
  showStatus("已切换编辑资料账号");
});

logsAccountFilter.addEventListener("change", async () => {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.LOGS,
    STORAGE_KEYS.RED_PACKET_GRAB_LOGS,
    STORAGE_KEYS.WS_MESSAGES
  ]);
  renderLogs(data[STORAGE_KEYS.LOGS] || []);
  const grabLogs = data[STORAGE_KEYS.RED_PACKET_GRAB_LOGS] || [];
  renderDailyStats(grabLogs);
  renderGrabLogs(grabLogs);
  renderWsMessages(data[STORAGE_KEYS.WS_MESSAGES] || []);
});

addAccountBtn.addEventListener("click", async () => {
  const bundle = await migrateAndLoadAccounts();
  const nextNum = bundle.accounts.length + 1;
  const id = newAccountId();
  const acc = normalizeAccount({ id, name: `账号${nextNum}`, token: "" }, bundle.accounts.length);
  const accounts = [...bundle.accounts, acc];
  await saveAccountsToStorage(accounts, id);
  await loadData();
  showStatus("已新增账号，请填写 Token 并保存");
});

removeAccountBtn.addEventListener("click", async () => {
  const bundle = await migrateAndLoadAccounts();
  if (bundle.accounts.length <= 1) {
    showStatus("至少保留一个账号", true);
    return;
  }
  const removedId = bundle.activeAccountId;
  const filtered = bundle.accounts.filter((a) => a.id !== removedId);
  const newActive = filtered[0].id;

  const featData = await chrome.storage.local.get([
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS
  ]);

  function stripRemoved(arr) {
    return Array.isArray(arr) ? arr.filter((id) => id !== removedId) : [];
  }

  await saveAccountsToStorage(filtered, newActive);
  await chrome.storage.local.set({
    [STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS]: stripRemoved(
      featData[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS]
    ),
    [STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS]: stripRemoved(
      featData[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS]
    ),
    [STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS]: stripRemoved(
      featData[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS]
    ),
    [STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS]: stripRemoved(featData[STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS])
  });
  await loadData();
  showStatus("已删除账号");
});

autoRedPacketInput.addEventListener("change", async () => {
  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTO_RED_PACKET]: autoRedPacketInput.checked
  });
  showStatus(autoRedPacketInput.checked ? "已开启自动抢红包" : "已关闭自动抢红包");
});

wsAutoGrabInput.addEventListener("change", async () => {
  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED]: wsAutoGrabInput.checked
  });
  showStatus(
    wsAutoGrabInput.checked
      ? "已开启插件内直连 WS（已保存）"
      : "已关闭插件内直连 WS（已保存）"
  );
});

autoDailySignInInput.addEventListener("change", async () => {
  const bundle = await migrateAndLoadAccounts();
  const editorIds = getCheckedIdsFromContainer(dailyFeatureAccounts);
  if (!editorIds.length) {
    showStatus("请在上方勾选至少一个账号", true);
    return;
  }
  const set = new Set(editorIds);
  const accounts = bundle.accounts.map((a) =>
    set.has(a.id) ? { ...a, autoDailySignInEnabled: autoDailySignInInput.checked } : a
  );
  await saveAccountsToStorage(accounts, bundle.activeAccountId);
  showStatus(
    autoDailySignInInput.checked
      ? `已为 ${editorIds.length} 个账号开启每日自动签到`
      : `已为 ${editorIds.length} 个账号关闭每日自动签到`
  );
});

autoDailyChatInput.addEventListener("change", async () => {
  const bundle = await migrateAndLoadAccounts();
  const editorIds = getCheckedIdsFromContainer(dailyFeatureAccounts);
  if (!editorIds.length) {
    showStatus("请在上方勾选至少一个账号", true);
    return;
  }
  const set = new Set(editorIds);
  const accounts = bundle.accounts.map((a) =>
    set.has(a.id) ? { ...a, autoDailyChatEnabled: autoDailyChatInput.checked } : a
  );
  await saveAccountsToStorage(accounts, bundle.activeAccountId);
  showStatus(
    autoDailyChatInput.checked
      ? `已为 ${editorIds.length} 个账号开启每日自动发言`
      : `已为 ${editorIds.length} 个账号关闭每日自动发言`
  );
});

autoPetCareInput.addEventListener("change", async () => {
  const bundle = await migrateAndLoadAccounts();
  const editorIds = getCheckedIdsFromContainer(petFeatureAccounts);
  if (!editorIds.length) {
    showStatus("请在宠物区块勾选至少一个账号", true);
    return;
  }
  const set = new Set(editorIds);
  const accounts = bundle.accounts.map((a) =>
    set.has(a.id) ? { ...a, autoPetCareEnabled: autoPetCareInput.checked } : a
  );
  await saveAccountsToStorage(accounts, bundle.activeAccountId);
  showStatus(
    autoPetCareInput.checked
      ? `已为 ${editorIds.length} 个账号开启自动喂养抚摸宠物`
      : `已为 ${editorIds.length} 个账号关闭自动喂养抚摸宠物`
  );
});

if (petCareIntervalSelect) {
  petCareIntervalSelect.addEventListener("change", async () => {
    const n = Number(petCareIntervalSelect.value);
    if (!Number.isFinite(n) || n < 5) {
      return;
    }
    const clamped = Math.min(24 * 60, Math.round(n));
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES]: clamped
    });
    showStatus(`已保存宠物自动执行间隔：${clamped} 分钟`);
  });
}

if (runDailyRoutineNowBtn) {
  runDailyRoutineNowBtn.addEventListener("click", async () => {
    const ids = getCheckedIdsFromContainer(dailyFeatureAccounts);
    if (!ids.length) {
      showStatus("请在「每日签到与发言」中勾选至少一个账号", true);
      return;
    }
    runDailyRoutineNowBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "RUN_DAILY_ROUTINE_NOW",
        accountIds: ids
      });
      if (chrome.runtime.lastError) {
        showStatus(chrome.runtime.lastError.message || "后台通信失败", true);
        return;
      }
      showStatus(
        resp?.ok ? resp.message || "已提交" : resp?.error || "执行失败",
        !resp?.ok
      );
    } catch (e) {
      showStatus(String(e), true);
    } finally {
      runDailyRoutineNowBtn.disabled = false;
    }
  });
}

if (runPetCareNowBtn) {
  runPetCareNowBtn.addEventListener("click", async () => {
    const ids = getCheckedIdsFromContainer(petFeatureAccounts);
    if (!ids.length) {
      showStatus("请在「宠物喂养抚摸」中勾选至少一个账号", true);
      return;
    }
    runPetCareNowBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "RUN_PET_CARE_NOW",
        accountIds: ids
      });
      if (chrome.runtime.lastError) {
        showStatus(chrome.runtime.lastError.message || "后台通信失败", true);
        return;
      }
      showStatus(
        resp?.ok ? resp.message || "已提交" : resp?.error || "执行失败",
        !resp?.ok
      );
    } catch (e) {
      showStatus(String(e), true);
    } finally {
      runPetCareNowBtn.disabled = false;
    }
  });
}

saveAutoGrabSettingsBtn.addEventListener("click", async () => {
  const wsUrl = wsUrlInput.value.trim();
  const apiBaseUrl = apiBaseUrlInput.value.trim();
  const wsEnabled = wsAutoGrabInput.checked;

  if (!wsUrl) {
    showStatus("请填写 WS 地址模板", true);
    return;
  }
  if (!/^wss?:\/\//i.test(wsUrl)) {
    showStatus("WS 地址必须以 ws:// 或 wss:// 开头", true);
    return;
  }

  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(apiBaseUrl);
  } catch {
    showStatus("API 基础地址格式不正确", true);
    return;
  }
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    showStatus("API 基础地址仅支持 http/https", true);
    return;
  }

  const bundle = await migrateAndLoadAccounts();
  const editorIds = getCheckedIdsFromContainer(dailyFeatureAccounts);
  const client = autoDailyChatClientInput.value.trim();
  let accounts = bundle.accounts;
  if (editorIds.length) {
    const set = new Set(editorIds);
    accounts = bundle.accounts.map((a) =>
      set.has(a.id) ? { ...a, autoDailyChatClient: client } : a
    );
  }

  const patch = {
    [STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED]: wsEnabled,
    [STORAGE_KEYS.AUTO_RED_PACKET_WS_URL]: wsUrl,
    [STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL]: parsedBaseUrl.toString().replace(/\/+$/, "")
  };
  if (accounts.length) {
    patch[STORAGE_KEYS.ACCOUNTS] = accounts.map((a, i) => normalizeAccount(a, i));
    patch[STORAGE_KEYS.ACTIVE_ACCOUNT_ID] = bundle.activeAccountId;
    const act = getActiveFromBundle({ accounts, activeAccountId: bundle.activeAccountId });
    if (act) {
      patch[STORAGE_KEYS.TOKEN] = act.token;
      patch[STORAGE_KEYS.TOKEN_HEADER_NAME] = act.tokenHeaderName;
    }
  }

  await chrome.storage.local.set(patch);

  showStatus("抢红包与 WS 设置已保存");
});

async function addTask() {
  const name = taskNameInput.value.trim();
  const url = taskUrlInput.value.trim();
  const method = (taskMethodInput.value || "GET").toUpperCase();
  const intervalSeconds = Number(taskIntervalInput.value);

  if (!name || !url || !intervalSeconds || intervalSeconds < 1) {
    showStatus("请正确填写任务名称、API 地址和时间间隔", true);
    return;
  }
  if (!["GET", "POST"].includes(method)) {
    showStatus("请求方法仅支持 GET/POST", true);
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    showStatus("API 地址格式不正确", true);
    return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    showStatus("API 地址仅支持 http/https", true);
    return;
  }

  const data = await chrome.storage.local.get(STORAGE_KEYS.TASKS);
  const tasks = data[STORAGE_KEYS.TASKS] || [];

  const newTask = {
    id: `task_${Date.now()}`,
    name,
    url: parsedUrl.toString(),
    method,
    intervalSeconds,
    nextRunAt: Date.now() + intervalSeconds * 1000
  };

  tasks.push(newTask);
  await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: tasks });

  taskNameInput.value = "";
  taskUrlInput.value = "";
  taskMethodInput.value = "GET";
  taskIntervalInput.value = "";

  renderTasks(tasks);
  showStatus("任务已创建");
}

async function removeTask(taskId) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TASKS);
  const tasks = data[STORAGE_KEYS.TASKS] || [];
  const updatedTasks = tasks.filter((task) => task.id !== taskId);

  await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: updatedTasks });
  renderTasks(updatedTasks);
  showStatus("任务已删除");
}

addTaskBtn.addEventListener("click", addTask);
refreshLogsBtn.addEventListener("click", async () => {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.LOGS,
    STORAGE_KEYS.RED_PACKET_GRAB_LOGS,
    STORAGE_KEYS.WS_MESSAGES
  ]);
  renderLogs(data[STORAGE_KEYS.LOGS] || []);
  const gl = data[STORAGE_KEYS.RED_PACKET_GRAB_LOGS] || [];
  renderDailyStats(gl);
  renderGrabLogs(gl);
  renderWsMessages(data[STORAGE_KEYS.WS_MESSAGES] || []);
  showStatus("已刷新日志（含筛选）");
});
refreshWsMessagesBtn.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.WS_MESSAGES);
  const wsMessages = data[STORAGE_KEYS.WS_MESSAGES] || [];
  renderWsMessages(wsMessages);
  showStatus("已刷新聊天室 WS");
});

if (clearAllLogsBtn) {
  clearAllLogsBtn.addEventListener("click", async () => {
    if (!confirm("确定清空全部日志？接口调用、WS 记录、抢红包明细将一并删除且不可恢复。")) {
      return;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.LOGS]: [],
      [STORAGE_KEYS.WS_MESSAGES]: [],
      [STORAGE_KEYS.RED_PACKET_GRAB_LOGS]: []
    });
    renderLogs([]);
    renderWsMessages([]);
    renderDailyStats([]);
    renderGrabLogs([]);
    showStatus("已清空全部日志");
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (
    changes[STORAGE_KEYS.ACCOUNTS] ||
    changes[STORAGE_KEYS.ACTIVE_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.TOKEN] ||
    changes[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS] ||
    changes[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS] ||
    changes[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS] ||
    changes[STORAGE_KEYS.FEATURE_PET_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_PET_ACCOUNT_IDS]
  ) {
    void loadData();
  }
  if (changes[STORAGE_KEYS.LOGS]) {
    renderLogs(changes[STORAGE_KEYS.LOGS].newValue || []);
  }
  if (changes[STORAGE_KEYS.WS_MESSAGES]) {
    const next = changes[STORAGE_KEYS.WS_MESSAGES].newValue || [];
    renderWsMessages(next);
  }
  if (changes[STORAGE_KEYS.RED_PACKET_GRAB_LOGS]) {
    const next = changes[STORAGE_KEYS.RED_PACKET_GRAB_LOGS].newValue || [];
    renderDailyStats(next);
    renderGrabLogs(next);
  }
  if (changes[STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES] && petCareIntervalSelect) {
    const nv = changes[STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES].newValue;
    const n = Number(nv);
    if (Number.isFinite(n)) {
      const v = Math.min(24 * 60, Math.max(5, Math.round(n)));
      const ok = [...petCareIntervalSelect.options].some((o) => Number(o.value) === v);
      if (ok) {
        petCareIntervalSelect.value = String(v);
      }
    }
  }
});

configTabBtn.addEventListener("click", () => switchTab("config"));
logsTabBtn.addEventListener("click", () => switchTab("logs"));

document.addEventListener("DOMContentLoaded", () => {
  initCollapseSections();
  void loadData();
});
