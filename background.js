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
  TASKS: "api_tasks",
  LOGS: "api_call_logs",
  AUTO_RED_PACKET: "auto_red_packet_enabled",
  AUTO_RED_PACKET_CLAIMED_IDS: "auto_red_packet_claimed_ids",
  AUTO_RED_PACKET_WS_ENABLED: "auto_red_packet_ws_enabled",
  AUTO_RED_PACKET_WS_URL: "auto_red_packet_ws_url",
  AUTO_RED_PACKET_API_BASE_URL: "auto_red_packet_api_base_url",
  WS_MESSAGES: "ws_messages",
  RED_PACKET_GRAB_LOGS: "red_packet_grab_logs",
  AUTO_DAILY_SIGN_IN_ENABLED: "auto_daily_sign_in_enabled",
  AUTO_DAILY_CHAT_ENABLED: "auto_daily_chat_enabled",
  AUTO_DAILY_LAST_SIGN_IN_DAY: "auto_daily_last_sign_in_day",
  AUTO_DAILY_LAST_CHAT_ROUTINE_DAY: "auto_daily_last_chat_routine_day",
  AUTO_DAILY_CHAT_STATE: "auto_daily_chat_state",
  AUTO_DAILY_CHAT_CLIENT: "auto_daily_chat_client",
  /** 宠物自动喂养抚摸：两次执行之间的间隔（分钟） */
  AUTO_PET_CARE_INTERVAL_MINUTES: "auto_pet_care_interval_minutes"
};

const SCHEDULER_ALARM = "api_scheduler_tick";
/** 每日任务闹钟名前缀 + accountId（多账号互不干扰） */
const ROUTINE_ALARM_SIGN_IN_PREFIX = "r_si_";
const ROUTINE_ALARM_CHAT_PREFIX = "r_ch_";
/** 宠物喂养抚摸：按固定间隔（accountId 后缀） */
const ROUTINE_ALARM_PET_PREFIX = "r_pc_";
const SCHEDULER_PERIOD_MINUTES = 0.5;
const DEFAULT_CHAT_CLIENT = "uTools/1.1.13";
const MAX_LOG_COUNT = 100;
const MAX_RED_PACKET_CACHE_SIZE = 200;
const MAX_WS_MESSAGE_COUNT = 200;
const MAX_WS_MESSAGE_CHARS = 8000;
const MAX_RED_PACKET_GRAB_LOGS = 150;
const DEFAULT_WS_URL_TEMPLATE = "wss://api.yucoder.cn/ws/?token={token}";
const DEFAULT_API_BASE_URL = "https://api.yucoder.cn";
const DEFAULT_TOKEN_HEADER_NAME = "fish-dog-token";

const WS_BRIDGE_PATTERN = /\[redpacket\]\s*([\s\S]*?)\s*\[\/redpacket\]/gi;
/** accountId -> WebSocket */
const wsClientsByAccountId = new Map();
/** accountId -> reconnect timer */
const wsReconnectTimersByAccountId = new Map();
/** WS 发言组包用：accountId -> { at, user }，与 Token 一致的后端用户 */
const chatLoginUserCacheByAccountId = new Map();
const CHAT_LOGIN_USER_CACHE_MS = 10 * 60 * 1000;

/** 串行抢红包队列，避免瞬时并发、更像人工点击间隔 */
const grabQueue = [];
let grabQueueRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomIntInclusive(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function startOfLocalDayMs(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function nextLocalMidnightMs(fromMs = Date.now()) {
  const d = new Date(fromMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * 当天 [h0:m0, h1:m1] 内随机一刻（不早于 now+minAheadMs）；若窗口已过则返回 null
 */
function randomTimeTodayBetween(h0, m0, h1, m1, nowMs, minAheadMs = 8000) {
  const day0 = startOfLocalDayMs(nowMs);
  const t0 = day0 + h0 * 3600000 + m0 * 60000;
  const t1 = day0 + h1 * 3600000 + m1 * 60000;
  const lo = Math.max(t0, nowMs + minAheadMs);
  const hi = t1;
  if (lo >= hi) {
    return null;
  }
  return randomIntInclusive(lo, hi);
}

function randomTimeTomorrowBetween(h0, m0, h1, m1) {
  const day0 = nextLocalMidnightMs();
  const t0 = day0 + h0 * 3600000 + m0 * 60000;
  const t1 = day0 + h1 * 3600000 + m1 * 60000;
  if (t0 >= t1) {
    return t0 + 60000;
  }
  return randomIntInclusive(t0, t1);
}

function parseJsonCodeMsg(text) {
  try {
    const parsed = JSON.parse(text);
    const rawCode = parsed?.code;
    const code = Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;
    let msg = "";
    if (typeof parsed?.msg === "string") {
      msg = parsed.msg;
    } else if (typeof parsed?.message === "string") {
      msg = parsed.message;
    }
    return { parsed, code, msg };
  } catch {
    return { parsed: null, code: null, msg: String(text || "").slice(0, 200) };
  }
}

const chatRoutineBusyAccountIds = new Set();

function newAccountId() {
  return `acc_${Date.now()}_${randomIntInclusive(1000, 9999)}`;
}

function normalizeAccount(raw, index = 0) {
  const id = String(raw?.id || "").trim() || newAccountId();
  let claimed = [];
  if (Array.isArray(raw?.redPacketClaimedIds)) {
    claimed = raw.redPacketClaimedIds.map((x) => String(x));
  }
  if (claimed.length > MAX_RED_PACKET_CACHE_SIZE) {
    claimed = claimed.slice(0, MAX_RED_PACKET_CACHE_SIZE);
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

function authHeadersFromAccount(account) {
  if (!account || !String(account.token || "").trim()) {
    return null;
  }
  const headerName =
    String(account.tokenHeaderName || "").trim() || DEFAULT_TOKEN_HEADER_NAME;
  return { [headerName]: String(account.token).trim() };
}

async function saveAccounts(accounts, activeAccountId) {
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

async function loadAccountsBundle() {
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
      const acc = normalizeAccount(
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
      );
      accounts = [acc];
      activeId = id;
      await saveAccounts(accounts, activeId);
    }
  } else if (activeId && !accounts.some((a) => a.id === activeId)) {
    activeId = accounts[0].id;
    await saveAccounts(accounts, activeId);
  } else if (!activeId && accounts.length) {
    activeId = accounts[0].id;
    await saveAccounts(accounts, activeId);
  }

  return { accounts, activeAccountId: activeId };
}

async function getActiveAccount() {
  const { accounts, activeAccountId } = await loadAccountsBundle();
  if (!accounts.length) {
    return null;
  }
  return accounts.find((a) => a.id === activeAccountId) || accounts[0];
}

async function resolveFeatureAccountIds(keysPlural, keysLegacy) {
  const data = await chrome.storage.local.get([
    keysPlural,
    keysLegacy,
    STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
    STORAGE_KEYS.ACCOUNTS
  ]);
  const rawAccounts = data[STORAGE_KEYS.ACCOUNTS];
  const accounts = Array.isArray(rawAccounts)
    ? rawAccounts.map((a, i) => normalizeAccount(a, i))
    : [];
  const arr = data[keysPlural];
  if (Array.isArray(arr) && arr.length === 0) {
    return { ids: [], accounts };
  }
  let ids = [];
  if (Array.isArray(arr) && arr.length) {
    ids = arr.map((x) => String(x || "").trim()).filter(Boolean);
  } else {
    const legacy = String(data[keysLegacy] || "").trim();
    if (legacy) {
      ids = [legacy];
    }
  }
  ids = [...new Set(ids)].filter((id) => accounts.some((a) => a.id === id));
  const fallback = String(data[STORAGE_KEYS.ACTIVE_ACCOUNT_ID] || "").trim();
  if (!ids.length && fallback && accounts.some((a) => a.id === fallback)) {
    ids = [fallback];
  }
  if (!ids.length && accounts[0]) {
    ids = [accounts[0].id];
  }
  return { ids, accounts };
}

async function getAccountById(accountId) {
  const { accounts } = await loadAccountsBundle();
  const id = String(accountId ?? "").trim();
  if (!id) {
    return null;
  }
  return accounts.find((a) => a.id === id) || null;
}

async function getFishTokenAuthHeadersForTasks() {
  const { ids } = await resolveFeatureAccountIds(
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_ID
  );
  const acc = await getAccountById(ids[0]);
  return authHeadersFromAccount(acc);
}

async function getFishTokenAuthHeadersForRedPacket() {
  const { ids } = await resolveFeatureAccountIds(
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_ID
  );
  const acc = await getAccountById(ids[0]);
  return authHeadersFromAccount(acc);
}

async function patchAccountById(accountId, partial) {
  const { accounts, activeAccountId } = await loadAccountsBundle();
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) {
    return null;
  }
  accounts[idx] = { ...accounts[idx], ...partial };
  await saveAccounts(accounts, activeAccountId);
  return accounts[idx];
}

async function getFishTokenAuthHeaders() {
  return getFishTokenAuthHeadersForTasks();
}

/**
 * 接近浏览器 XHR/fetch 的常见头，降低 Service Worker 裸请求被风控识别的概率
 * （服务端仍以 Sa-Token 头为准；Referer 指向 API 站点根路径）
 */
function buildRedPacketGrabHeaders(authHeaders, apiBaseUrl) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Content-Type": "application/json",
    ...authHeaders
  };
  try {
    const origin = new URL(apiBaseUrl).origin;
    headers.Referer = `${origin}/`;
  } catch {
    /* ignore */
  }
  return headers;
}

async function processGrabQueue() {
  if (grabQueueRunning) {
    return;
  }
  grabQueueRunning = true;
  try {
    while (grabQueue.length > 0) {
      const job = grabQueue.shift();
      const redPacketId = job?.redPacketId;
      const accountId = job?.accountId;
      await sleep(randomIntInclusive(320, 980));
      await executeGrabRedPacketOnce(redPacketId, accountId);
      if (grabQueue.length > 0) {
        await sleep(randomIntInclusive(480, 1600));
      }
    }
  } finally {
    grabQueueRunning = false;
  }
}

function grabQueueKey(redPacketId, accountId) {
  return `${String(accountId || "").trim()}:${String(redPacketId || "").trim()}`;
}

/**
 * 入队抢红包（WS / 页面桥统一走此入口）
 */
function enqueueGrabRedPacket(redPacketId, accountId) {
  const id = String(redPacketId || "").trim();
  const aid = String(accountId || "").trim();
  if (!id || !aid) {
    return;
  }
  const k = grabQueueKey(id, aid);
  if (grabQueue.some((j) => grabQueueKey(j.redPacketId, j.accountId) === k)) {
    return;
  }
  grabQueue.push({ redPacketId: id, accountId: aid });
  void processGrabQueue();
}

async function syncTaskAlarms() {
  chrome.alarms.create(SCHEDULER_ALARM, {
    periodInMinutes: SCHEDULER_PERIOD_MINUTES
  });

  const data = await chrome.storage.local.get(STORAGE_KEYS.TASKS);
  const tasks = data[STORAGE_KEYS.TASKS] || [];
  let hasMigration = false;
  const now = Date.now();

  const normalizedTasks = tasks.map((task) => {
    const normalized = { ...task };
    if (!normalized.method) {
      normalized.method = "GET";
      hasMigration = true;
    }
    if (!normalized.intervalSeconds && normalized.intervalMinutes) {
      normalized.intervalSeconds = Number(normalized.intervalMinutes) * 60;
      hasMigration = true;
    }
    if (!normalized.nextRunAt && normalized.intervalSeconds) {
      normalized.nextRunAt = now + Number(normalized.intervalSeconds) * 1000;
      hasMigration = true;
    }
    return normalized;
  });

  if (hasMigration) {
    await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: normalizedTasks });
  }
}

async function appendCallLog(log) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LOGS);
  const logs = data[STORAGE_KEYS.LOGS] || [];
  logs.unshift(log);
  if (logs.length > MAX_LOG_COUNT) {
    logs.length = MAX_LOG_COUNT;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: logs });
}

function isNoiseWsFrame(parsed) {
  if (!parsed || typeof parsed !== "object") return true;
  const t = parsed.type;
  const ts = typeof t === "string" ? t.toLowerCase() : "";
  if (ts === "heartbeat" || ts === "ping" || ts === "pong") return true;
  if (t === 4) return true;
  return false;
}

function shouldAppendWsMessage(raw) {
  const text = String(raw || "").trim();
  if (!text) return false;
  if (/\[redpacket\]/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text);
    if (isNoiseWsFrame(parsed)) return false;
    if (parsed.type === "chat" && parsed.data && parsed.data.message) return true;
    if (parsed.type === "barrager" && (parsed.barragerContent || parsed.userName)) return true;
    if (parsed.oId && typeof parsed.content === "string") return true;
    if (parsed.type === "msg" && parsed.oId && typeof parsed.content === "string") return true;
  } catch {
    return false;
  }
  return false;
}

async function appendWsMessageLog(payload, accountId, accountName) {
  const raw = String(payload || "").slice(0, MAX_WS_MESSAGE_CHARS);
  if (!shouldAppendWsMessage(raw)) {
    return;
  }
  const data = await chrome.storage.local.get(STORAGE_KEYS.WS_MESSAGES);
  const logs = data[STORAGE_KEYS.WS_MESSAGES] || [];
  logs.unshift({
    createdAt: Date.now(),
    message: raw,
    accountId: accountId ? String(accountId) : "",
    accountName: accountName ? String(accountName) : ""
  });
  if (logs.length > MAX_WS_MESSAGE_COUNT) {
    logs.length = MAX_WS_MESSAGE_COUNT;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.WS_MESSAGES]: logs });
}

async function appendRedPacketGrabLog(entry) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RED_PACKET_GRAB_LOGS);
  const logs = data[STORAGE_KEYS.RED_PACKET_GRAB_LOGS] || [];
  logs.unshift(entry);
  if (logs.length > MAX_RED_PACKET_GRAB_LOGS) {
    logs.length = MAX_RED_PACKET_GRAB_LOGS;
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.RED_PACKET_GRAB_LOGS]: logs
  });
}

async function markRedPacketClaimed(redPacketId, accountId) {
  const aid = String(accountId || "").trim();
  const { accounts, activeAccountId } = await loadAccountsBundle();
  const idx = accounts.findIndex((a) => a.id === aid);
  if (idx < 0) {
    return;
  }
  const existed = accounts[idx].redPacketClaimedIds || [];
  const deduped = [redPacketId, ...existed.filter((id) => id !== redPacketId)];
  if (deduped.length > MAX_RED_PACKET_CACHE_SIZE) {
    deduped.length = MAX_RED_PACKET_CACHE_SIZE;
  }
  accounts[idx] = { ...accounts[idx], redPacketClaimedIds: deduped };
  await saveAccounts(accounts, activeAccountId);
}

async function hasRedPacketBeenClaimed(redPacketId, accountId) {
  const acc = await getAccountById(accountId);
  if (!acc) {
    return false;
  }
  const existed = acc.redPacketClaimedIds || [];
  return existed.includes(redPacketId);
}

function normalizeApiBaseUrl(rawBaseUrl) {
  const text = String(rawBaseUrl || DEFAULT_API_BASE_URL).trim();
  if (!text) return DEFAULT_API_BASE_URL;
  return text.replace(/\/+$/, "");
}

function buildWsUrl(wsUrlTemplate, token) {
  const text = String(wsUrlTemplate || DEFAULT_WS_URL_TEMPLATE).trim();
  if (!text) return "";
  if (text.includes("{token}")) {
    return text.replaceAll("{token}", encodeURIComponent(token));
  }
  if (text.includes("token=")) return text;
  return `${text}${text.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/** 写日志用，避免把 token 明文打进接口记录 */
function maskWsUrlForLog(wsUrl) {
  const u = String(wsUrl || "");
  if (!u) return "";
  return u.replace(/([?&])token=[^&]*/i, "$1token=***");
}

/**
 * 部分后端把登录用户包在 data.user / userVo 里，与 typings 里的平铺 LoginUserVO 不同。
 */
function unwrapLoginUserPayload(data) {
  if (!data || typeof data !== "object") return null;
  const inner =
    data.user ||
    data.userVo ||
    data.loginUser ||
    data.loginUserVo ||
    data.currentUser;
  if (inner && typeof inner === "object") {
    const innerHasId = inner.id != null && String(inner.id).trim() !== "";
    if (innerHasId) {
      return inner;
    }
    const outerHasId = data.id != null && String(data.id).trim() !== "";
    if (outerHasId) {
      return { ...inner, id: data.id };
    }
    if (
      String(inner.userName || inner.userAccount || inner.userNickname || "").trim()
    ) {
      return inner;
    }
  }
  return data;
}

/** 公屏 WS 里 sender.name：只用接口用户字段，不用插件里起的「账号备注名」 */
function pickChatSenderDisplayName(u) {
  if (!u || typeof u !== "object") return "";
  const order = [
    u.userName,
    u.userAccount,
    u.userNickname,
    u.nickName,
    u.name,
    u.account,
    u.email
  ];
  for (const c of order) {
    const s = String(c || "").trim();
    if (s) {
      if (c === u.email && s.includes("@")) {
        return s.split("@")[0].trim() || s;
      }
      return s;
    }
  }
  if (u.id != null && String(u.id).trim() !== "") {
    return `用户${u.id}`;
  }
  return "";
}

function normalizeTitleIdListForSender(raw) {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    return raw.length ? raw : undefined;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return undefined;
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j) && j.length) return j;
    } catch {
      /* ignore */
    }
    if (t.includes(",")) {
      const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
      return parts.length ? parts : undefined;
    }
    return [t];
  }
  return undefined;
}

/**
 * 拉取当前 Token 对应的后端用户（与 uTools userStore 一致），用于 WS 聊天帧里的 sender。
 * 仅用插件里自定义的「账号名」填 sender 时，服务端常直接丢弃，聊天室就看不到记录。
 *
 * 摸鱼岛网页登录后会把 Sa-Token 头名存在 localStorage.tokenName（与 fish-dog-token 可能不同）。
 * 若账号未填「请求头名称」，默认 fish-dog-token 会导致接口返回「未登录」，故对常见头名做依次尝试。
 */
async function fetchLoginUserForChatWs(account) {
  const aid = String(account?.id || "").trim();
  if (!aid) {
    return { ok: false, user: null, error: "无账号 id" };
  }
  const token = String(account?.token || "").trim();
  const hit = chatLoginUserCacheByAccountId.get(aid);
  if (
    hit?.user &&
    hit.token === token &&
    Date.now() - hit.at < CHAT_LOGIN_USER_CACHE_MS
  ) {
    return { ok: true, user: hit.user, error: "" };
  }

  if (!token) {
    return { ok: false, user: null, error: "无 Token" };
  }

  const configured = String(account?.tokenHeaderName || "").trim() || DEFAULT_TOKEN_HEADER_NAME;
  const headerNameCandidates = [...new Set([configured, "fish-dog-token", "satoken"])].filter(
    Boolean
  );

  let lastErr = "未登录";
  const baseUrl = await getApiBaseFromStorage();
  const url = `${baseUrl}/api/user/get/login`;

  for (const headerName of headerNameCandidates) {
    const authHeaders = { [headerName]: token };
    const baseHeaders = buildRedPacketGrabHeaders(authHeaders, baseUrl);
    const headers = { ...baseHeaders };
    delete headers["Content-Type"];

    try {
      const res = await fetch(url, {
        method: "GET",
        headers,
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "strict-origin-when-cross-origin"
      });
      const text = await res.text();
      const { code, msg } = parseJsonCodeMsg(text);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      let data =
        parsed && typeof parsed.data === "object" && parsed.data !== null && !Array.isArray(parsed.data)
          ? parsed.data
          : null;
      if (!data && parsed && parsed.id != null && typeof parsed === "object") {
        data = parsed;
      }
      if (data) {
        data = unwrapLoginUserPayload(data);
      }

      const errText = (msg || text || `HTTP ${res.status}`).slice(0, 200);
      if (!res.ok || code !== 0 || !data) {
        lastErr = errText;
        const looksAuth =
          /未登录|未登陆|token|Token|登录|鉴权|401|无效/i.test(errText) ||
          code === 401 ||
          code === 40100 ||
          code === -1;
        if (looksAuth) {
          continue;
        }
        return { ok: false, user: null, error: errText };
      }

      const rid = data.id;
      if (rid === undefined || rid === null || String(rid).trim() === "") {
        return { ok: false, user: null, error: "登录信息缺少用户 id" };
      }
      chatLoginUserCacheByAccountId.set(aid, { at: Date.now(), user: data, token });
      return { ok: true, user: data, error: "" };
    } catch (e) {
      lastErr = String(e).slice(0, 200);
    }
  }

  const hint =
    /未登录|未登陆/i.test(lastErr)
      ? " 请在浏览器摸鱼岛 F12 → Application → Local Storage 查看 tokenName，把账号「请求头名称」改成与之一致后再保存。"
      : "";
  return { ok: false, user: null, error: `${lastErr}${hint}`.slice(0, 320) };
}

/**
 * 与 fish-island-utools 聊天室一致：外层 type 2 + data.type chat + content.message。
 * sender 必须全部来自 get/login 返回的用户对象（与网页 userStore 同源），不使用插件账号备注名。
 * @param {object} loginUser 已通过 fetchLoginUserForChatWs 校验含 id
 */
function buildChatRoomWebSocketText(content, loginUser) {
  const u = loginUser && typeof loginUser === "object" ? loginUser : null;
  const rid = u?.id;
  if (!u || rid === undefined || rid === null || String(rid).trim() === "") {
    throw new Error("buildChatRoomWebSocketText: 缺少登录用户 id");
  }
  const now = Date.now();
  const displayName = pickChatSenderDisplayName(u) || `用户${rid}`;
  const uid = String(rid);
  const fallbackAvatar =
    String(u.userAvatar || "").trim() ||
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(displayName)}`;
  const levelN = Number(u.level);
  const pointsN = Number(u.points ?? u.userPoint);
  const message = {
    id: String(now),
    content: String(content ?? ""),
    sender: {
      id: uid,
      name: displayName,
      avatar: fallbackAvatar,
      level: Number.isFinite(levelN) ? levelN : 1,
      points: Number.isFinite(pointsN) ? pointsN : 0,
      isAdmin: u.userRole === "admin",
      isVip: !!u.vip,
      region: "未知地区",
      country: "未知国家"
    },
    timestamp: new Date(now).toISOString(),
    region: "未知地区",
    country: "未知国家"
  };
  if (u.avatarFramerUrl) {
    message.sender.avatarFramerUrl = u.avatarFramerUrl;
  }
  if (u.titleId != null && u.titleId !== "") {
    message.sender.titleId = u.titleId;
  }
  const titleList = normalizeTitleIdListForSender(u.titleIdList);
  if (titleList) {
    message.sender.titleIdList = titleList;
  }
  return JSON.stringify({
    type: 2,
    userId: -1,
    data: {
      type: "chat",
      content: { message }
    }
  });
}

function emitRedPacketCandidatesFromContent(content, onFound) {
  if (typeof content !== "string" || !content) return;
  WS_BRIDGE_PATTERN.lastIndex = 0;
  let match = WS_BRIDGE_PATTERN.exec(content);
  while (match) {
    const captured = String(match[1] || "").trim();
    if (captured) {
      try {
        const parsed = JSON.parse(captured);
        const redPacketId = parsed && typeof parsed === "object" ? parsed.id : captured;
        if (redPacketId != null) onFound(String(redPacketId).trim());
      } catch {
        onFound(captured);
      }
    }
    match = WS_BRIDGE_PATTERN.exec(content);
  }
}

function deepScanForRedPacket(payload, onFound) {
  if (payload == null) return;
  if (typeof payload === "string") {
    emitRedPacketCandidatesFromContent(payload, onFound);
    try {
      deepScanForRedPacket(JSON.parse(payload), onFound);
    } catch {
      // ignore json parse failures
    }
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((item) => deepScanForRedPacket(item, onFound));
    return;
  }
  if (typeof payload === "object") {
    Object.values(payload).forEach((value) => deepScanForRedPacket(value, onFound));
  }
}

function parseGrabJsonBody(text) {
  if (text == null || String(text).trim() === "") {
    return { parsed: null, apiCode: null, amount: null, msg: "" };
  }
  try {
    const parsed = JSON.parse(text);
    const rawCode = parsed?.code;
    const apiCode = Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;
    const msg = typeof parsed?.msg === "string" ? parsed.msg : "";
    let amount = null;
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "data")) {
      const n = Number(parsed.data);
      if (Number.isFinite(n)) {
        amount = n;
      }
    }
    return { parsed, apiCode, amount, msg };
  } catch {
    return { parsed: null, apiCode: null, amount: null, msg: String(text).slice(0, 200) };
  }
}

function isGrabApiSuccess(httpOk, apiCode, amount) {
  return httpOk && apiCode === 0 && amount != null;
}

async function executeGrabRedPacketOnce(redPacketId, accountId) {
  if (!redPacketId || !accountId) return;

  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.AUTO_RED_PACKET,
    STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL
  ]);
  const autoEnabled = storage[STORAGE_KEYS.AUTO_RED_PACKET] !== false;
  const baseUrl = normalizeApiBaseUrl(
    storage[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL] || DEFAULT_API_BASE_URL
  );

  const acc = await getAccountById(accountId);
  const authHeaders = authHeadersFromAccount(acc);
  if (!autoEnabled || !authHeaders) return;
  if (await hasRedPacketBeenClaimed(redPacketId, accountId)) return;

  const url = `${baseUrl}/api/redpacket/grab?redPacketId=${encodeURIComponent(redPacketId)}`;
  const now = Date.now();
  const headers = buildRedPacketGrabHeaders(authHeaders, baseUrl);
  const actLabel = acc ? { accountId: acc.id, accountName: acc.name } : {};

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      credentials: "omit",
      mode: "cors",
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    const text = await response.text();
    const { apiCode, amount, msg } = parseGrabJsonBody(text);
    const httpOk = response.ok;
    const success = isGrabApiSuccess(httpOk, apiCode, amount);
    const summaryMsg =
      msg ||
      (typeof text === "string" ? text.slice(0, 240) : "");

    await appendRedPacketGrabLog({
      createdAt: now,
      redPacketId,
      success,
      amount,
      apiCode,
      httpOk,
      statusCode: response.status,
      message: summaryMsg,
      ...actLabel
    });

    await appendCallLog({
      createdAt: now,
      taskId: "auto_red_packet",
      taskName: `自动抢红包 · ${acc?.name || "?"}`,
      method: "POST",
      url,
      success,
      statusCode: response.status,
      message: success ? `抢到 ${amount} 积分` : summaryMsg.slice(0, 120),
      ...actLabel
    });

    await markRedPacketClaimed(redPacketId, accountId);
    console.log(
      success
        ? `🧧 自动抢红包成功 ${redPacketId}，积分 +${amount}`
        : `🧧 自动抢红包结束 ${redPacketId}，HTTP ${response.status} code=${apiCode}`
    );
  } catch (error) {
    const errText = String(error).slice(0, 240);
    await appendRedPacketGrabLog({
      createdAt: now,
      redPacketId,
      success: false,
      amount: null,
      apiCode: null,
      httpOk: false,
      statusCode: null,
      message: errText,
      ...actLabel
    });
    await appendCallLog({
      createdAt: now,
      taskId: "auto_red_packet",
      taskName: `自动抢红包 · ${acc?.name || "?"}`,
      method: "POST",
      url,
      success: false,
      statusCode: null,
      message: errText.slice(0, 120),
      ...actLabel
    });
    console.error("🧧 自动抢红包失败:", error);
  }
}

/** WS / content 脚本入口：入队 + 随机延迟后请求，避免脚本特征 */
async function tryAutoGrabRedPacket({ redPacketId, accountId }) {
  const id = String(redPacketId || "").trim();
  if (!id) {
    return;
  }
  const aid = String(accountId || "").trim();
  if (aid) {
    enqueueGrabRedPacket(id, aid);
    return;
  }
  const { ids } = await resolveFeatureAccountIds(
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_ID
  );
  for (const x of ids) {
    enqueueGrabRedPacket(id, x);
  }
}

function clearWsReconnectTimer(accountId) {
  const t = wsReconnectTimersByAccountId.get(accountId);
  if (t) {
    clearTimeout(t);
    wsReconnectTimersByAccountId.delete(accountId);
  }
}

function scheduleWsReconnect(accountId) {
  clearWsReconnectTimer(accountId);
  wsReconnectTimersByAccountId.set(
    accountId,
    setTimeout(() => {
    ensureWsAutoGrabConnection();
    }, 5000)
  );
}

function closeWsForAccount(accountId) {
  clearWsReconnectTimer(accountId);
  const c = wsClientsByAccountId.get(accountId);
  if (c) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
    wsClientsByAccountId.delete(accountId);
  }
}

function closeAllWsClients() {
  for (const id of [...wsClientsByAccountId.keys()]) {
    closeWsForAccount(id);
  }
}

function openWsForAccount(accountId, accountName, token, wsUrlTemplate, autoEnabled, wsEnabled) {
  if (!autoEnabled || !wsEnabled || !String(token || "").trim()) {
    closeWsForAccount(accountId);
    return;
  }

  const wsUrl = buildWsUrl(wsUrlTemplate, token);
  if (!wsUrl) {
    closeWsForAccount(accountId);
    return;
  }

  const existing = wsClientsByAccountId.get(accountId);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
  ) {
    try {
      if (existing.url === wsUrl) {
        return;
      }
    } catch {
      /* ignore */
    }
    closeWsForAccount(accountId);
  }

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    console.error("WebSocket 创建失败:", accountId, error);
    scheduleWsReconnect(accountId);
    return;
  }

  wsClientsByAccountId.set(accountId, ws);

  ws.addEventListener("open", async () => {
    clearWsReconnectTimer(accountId);
    console.log(`🧧 自动抢红包 WS 已连接 [${accountName}]`);
    try {
      await sleep(randomIntInclusive(40, 220));
      ws.send(JSON.stringify({ type: 1 }));
    } catch {
      /* ignore */
    }
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_red_packet_ws",
      taskName: `自动抢红包WS · ${accountName}`,
      method: "WS",
      url: wsUrl,
      success: true,
      statusCode: 101,
      message: "WebSocket connected",
      accountId,
      accountName
    });
  });

  ws.addEventListener("message", (event) => {
    appendWsMessageLog(event?.data, accountId, accountName);
    deepScanForRedPacket(event?.data, (candidateId) => {
      tryAutoGrabRedPacket({
        redPacketId: candidateId,
        accountId
      });
    });
  });

  ws.addEventListener("error", async () => {
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_red_packet_ws",
      taskName: `自动抢红包WS · ${accountName}`,
      method: "WS",
      url: wsUrl,
      success: false,
      statusCode: null,
      message: "WebSocket error",
      accountId,
      accountName
    });
  });

  ws.addEventListener("close", async () => {
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_red_packet_ws",
      taskName: `自动抢红包WS · ${accountName}`,
      method: "WS",
      url: wsUrl,
      success: false,
      statusCode: null,
      message: "WebSocket closed, reconnecting",
      accountId,
      accountName
    });
    wsClientsByAccountId.delete(accountId);
    scheduleWsReconnect(accountId);
  });
}

async function ensureWsAutoGrabConnection() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.AUTO_RED_PACKET,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_URL,
    STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL
  ]);
  const autoEnabled = data[STORAGE_KEYS.AUTO_RED_PACKET] !== false;
  const wsEnabled = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED] !== false;
  const wsUrlTemplate = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] || DEFAULT_WS_URL_TEMPLATE;

  const { ids, accounts } = await resolveFeatureAccountIds(
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_ID
  );

  const wanted = new Set(
    ids.filter((id) => {
      const a = accounts.find((x) => x.id === id);
      return a && String(a.token || "").trim();
    })
  );

  if (!autoEnabled || !wsEnabled || !wanted.size) {
    closeAllWsClients();
    return;
  }

  for (const existingId of [...wsClientsByAccountId.keys()]) {
    if (!wanted.has(existingId)) {
      closeWsForAccount(existingId);
    }
  }

  for (const id of wanted) {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) {
      continue;
    }
    openWsForAccount(id, acc.name, acc.token, wsUrlTemplate, autoEnabled, wsEnabled);
  }
}

async function getApiBaseFromStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL);
  return normalizeApiBaseUrl(
    data[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL] || DEFAULT_API_BASE_URL
  );
}

async function syncDailyRoutineAlarms() {
  const { accounts } = await loadAccountsBundle();
  const now = Date.now();
  const todayKey = localDayKey(now);
  const wantedSi = new Set();
  const wantedCh = new Set();

  for (const acc of accounts) {
    const siName = ROUTINE_ALARM_SIGN_IN_PREFIX + acc.id;
    const chName = ROUTINE_ALARM_CHAT_PREFIX + acc.id;

    if (acc.autoDailySignInEnabled === true) {
      wantedSi.add(acc.id);
      const last = acc.dailyLastSignInDay;
      let when;
      if (last === todayKey) {
        when = randomTimeTomorrowBetween(7, 0, 11, 45);
      } else {
        when = randomTimeTodayBetween(7, 0, 11, 45, now);
        if (when == null) {
          when = randomTimeTomorrowBetween(7, 0, 11, 45);
        }
      }
      await chrome.alarms.create(siName, { when });
    } else {
      await chrome.alarms.clear(siName);
    }

    if (acc.autoDailyChatEnabled === true) {
      wantedCh.add(acc.id);
      const last = acc.dailyLastChatRoutineDay;
      const st = acc.dailyChatState;
      const ni = Number(st?.nextIndex);
      const pendingResume =
        last !== todayKey &&
        st &&
        typeof st === "object" &&
        st.dayKey === todayKey &&
        Number.isFinite(ni) &&
        ni >= 1 &&
        ni <= 20;

      if (pendingResume) {
        await chrome.alarms.create(chName, {
          when: now + randomIntInclusive(4000, 16000)
        });
      } else if (last === todayKey) {
        await chrome.alarms.create(chName, {
          when: randomTimeTomorrowBetween(14, 0, 22, 20)
        });
      } else {
        let when = randomTimeTodayBetween(14, 0, 22, 20, now);
        if (when == null) {
          when = randomTimeTomorrowBetween(14, 0, 22, 20);
        }
        await chrome.alarms.create(chName, { when });
      }
    } else {
      await chrome.alarms.clear(chName);
    }
  }

  const all = await chrome.alarms.getAll();
  await Promise.all(
    all
      .filter((a) => {
        if (a.name.startsWith(ROUTINE_ALARM_SIGN_IN_PREFIX)) {
          const id = a.name.slice(ROUTINE_ALARM_SIGN_IN_PREFIX.length);
          return !wantedSi.has(id);
        }
        if (a.name.startsWith(ROUTINE_ALARM_CHAT_PREFIX)) {
          const id = a.name.slice(ROUTINE_ALARM_CHAT_PREFIX.length);
          return !wantedCh.has(id);
        }
        return false;
      })
      .map((a) => chrome.alarms.clear(a.name))
  );
}

function parsePetDetailFromResponseText(text) {
  const { parsed, code, msg } = parseJsonCodeMsg(text);
  const rawCode = Number.isFinite(Number(code)) ? Number(code) : null;
  const d = parsed?.data;
  if (!d || typeof d !== "object") {
    return {
      code: rawCode,
      msg: typeof msg === "string" ? msg : "",
      petId: null,
      mood: null,
      hunger: null
    };
  }
  const pid = d.petId ?? d.id;
  const moodN = Number(d.mood);
  const hungerN = Number(d.hunger);
  return {
    code: rawCode,
    msg: typeof msg === "string" ? msg : "",
    petId: pid !== undefined && pid !== null && pid !== "" ? pid : null,
    mood: Number.isFinite(moodN) ? moodN : null,
    hunger: Number.isFinite(hungerN) ? hungerN : null
  };
}

/**
 * @param {string} accountId
 * @param {{ token?: string; tokenHeaderName?: string }} [overrides] 弹窗未保存时可用输入框里的 Token 发起请求
 */
async function fetchMyPetIdForAccount(accountId, overrides = {}) {
  const aid = String(accountId || "").trim();
  if (!aid) {
    return { ok: false, error: "未指定账号", petId: null };
  }
  const account = await getAccountById(aid);
  if (!account) {
    return { ok: false, error: "账号不存在", petId: null };
  }
  const tokenOverride = String(overrides.token ?? "").trim();
  const headerOverride = String(overrides.tokenHeaderName ?? "").trim();
  const token =
    tokenOverride ||
    String(account.token || "").trim();
  let authHeaders = null;
  if (token) {
    const headerName =
      headerOverride ||
      String(account.tokenHeaderName || "").trim() ||
      DEFAULT_TOKEN_HEADER_NAME;
    authHeaders = { [headerName]: token };
  } else {
    authHeaders = authHeadersFromAccount(account);
  }
  const baseUrl = await getApiBaseFromStorage();
  if (!authHeaders) {
    return {
      ok: false,
      error: "未配置 Token（请填写 Token 或先保存账号资料）",
      petId: null
    };
  }
  const baseHeaders = buildRedPacketGrabHeaders(authHeaders, baseUrl);
  const headers = { ...baseHeaders };
  delete headers["Content-Type"];
  const detailUrl = `${baseUrl}/api/pet/my/get`;
  try {
    const res = await fetch(detailUrl, {
      method: "GET",
      headers,
      credentials: "omit",
      mode: "cors",
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    const text = await res.text();
    let parsedRoot = null;
    try {
      parsedRoot = JSON.parse(text);
    } catch {
      parsedRoot = null;
    }
    if (
      parsedRoot &&
      Number(parsedRoot.code) === 0 &&
      (parsedRoot.data === null || typeof parsedRoot.data === "undefined")
    ) {
      return {
        ok: false,
        error:
          "接口返回 data 为空（未登录）：请确认 Token 正确、请求头名称与站点一致（默认 fish-dog-token），可先点「保存账号资料」再试；若刚在输入框填写 Token，请再点一次「获取宠物 ID」",
        petId: null
      };
    }
    const st = parsePetDetailFromResponseText(text);
    if (!res.ok || st.code !== 0) {
      return {
        ok: false,
        error: st.msg || `HTTP ${res.status}`,
        petId: null
      };
    }
    if (st.petId == null || st.petId === "") {
      return {
        ok: false,
        error:
          "接口未返回 petId（data 非对象或无宠物）；若已在网页能查到宠物，请检查 Token 是否与浏览器一致",
        petId: null
      };
    }
    return { ok: true, petId: String(st.petId), error: null };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120), petId: null };
  }
}

async function getPetCareIntervalMinutes() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES);
  const n = Number(data[STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES]);
  if (Number.isFinite(n)) {
    return Math.min(24 * 60, Math.max(5, Math.round(n)));
  }
  return 60;
}

async function reschedulePetCareAlarm(accountId) {
  const min = await getPetCareIntervalMinutes();
  await chrome.alarms.create(ROUTINE_ALARM_PET_PREFIX + accountId, {
    when: Date.now() + min * 60000
  });
}

async function petCareDoneReschedule(accountId, manual) {
  if (!manual) {
    await reschedulePetCareAlarm(accountId);
    return;
  }
  const acc = await getAccountById(accountId);
  if (acc?.autoPetCareEnabled === true) {
    await reschedulePetCareAlarm(accountId);
  }
}

async function syncPetCareAlarms(options = {}) {
  const { accounts } = await loadAccountsBundle();
  const wanted = new Set();
  const now = Date.now();
  const intervalMin = await getPetCareIntervalMinutes();
  const nextWhen = now + intervalMin * 60000;

  for (const acc of accounts) {
    const name = ROUTINE_ALARM_PET_PREFIX + acc.id;
    if (
      acc.autoPetCareEnabled === true &&
      String(acc.token || "").trim() &&
      String(acc.petId || "").trim()
    ) {
      wanted.add(acc.id);
      const existing = await chrome.alarms.get(name);
      const stale =
        options.forceReschedule === true ||
        !existing ||
        !Number(existing.scheduledTime) ||
        Number(existing.scheduledTime) <= now;
      if (stale) {
        await chrome.alarms.create(name, { when: nextWhen });
      }
    } else {
      await chrome.alarms.clear(name);
    }
  }

  const all = await chrome.alarms.getAll();
  await Promise.all(
    all
      .filter(
        (a) =>
          a.name.startsWith(ROUTINE_ALARM_PET_PREFIX) &&
          !wanted.has(a.name.slice(ROUTINE_ALARM_PET_PREFIX.length))
      )
      .map((a) => chrome.alarms.clear(a.name))
  );
}

/**
 * @param {string} accountId
 * @param {boolean} manual 手动触发：不要求已开启自动；未开启自动时不顺延下次闹钟
 */
async function runPetCareOnce(accountId, manual) {
  if (!accountId) {
    if (!manual) {
      await syncPetCareAlarms();
    }
    return;
  }

  try {
    const { accounts } = await loadAccountsBundle();
    const account = accounts.find((a) => a.id === accountId);
    if (!account || (!manual && account.autoPetCareEnabled !== true)) {
      if (!manual) {
        await syncPetCareAlarms();
      }
      return;
    }

    const authHeaders = authHeadersFromAccount(account);
    const baseUrl = await getApiBaseFromStorage();
    const label = manual
      ? `宠物喂养抚摸 · ${account.name}（手动）`
      : `宠物喂养抚摸 · ${account.name}`;

    if (!authHeaders) {
      await appendCallLog({
        createdAt: Date.now(),
        taskId: "auto_pet_care",
        taskName: label,
        method: "-",
        url: "(未请求)",
        success: false,
        statusCode: null,
        message: "未配置 Token，跳过",
        accountId: account.id,
        accountName: account.name
      });
      await petCareDoneReschedule(accountId, manual);
      return;
    }

    const petId = String(account.petId || "").trim();
    if (!petId) {
      await appendCallLog({
        createdAt: Date.now(),
        taskId: "auto_pet_care",
        taskName: label,
        method: "-",
        url: "(未请求)",
        success: false,
        statusCode: null,
        message: "账号未保存宠物 ID，请在配置「账号」中填写或获取后点「保存账号资料」",
        accountId: account.id,
        accountName: account.name
      });
      await petCareDoneReschedule(accountId, manual);
      return;
    }

    const headers = buildRedPacketGrabHeaders(authHeaders, baseUrl);
    let moodNow = null;
    let hungerNow = null;

    let moodOk = moodNow !== null && moodNow >= 100;

    if (!moodOk) {
      let patUrl = `${baseUrl}/api/pet/pat?petId=${encodeURIComponent(petId)}`;
      try {
        const res = await fetch(patUrl, {
          method: "POST",
          headers,
          body: "{}",
          credentials: "omit",
          mode: "cors",
          referrerPolicy: "strict-origin-when-cross-origin"
        });
        const text = await res.text();
        const st = parsePetDetailFromResponseText(text);
        const ok = res.ok && st.code === 0;
        if (ok) {
          if (st.mood != null) {
            moodNow = st.mood;
          }
          if (st.hunger != null) {
            hungerNow = st.hunger;
          }
        }
        moodOk = moodNow !== null && moodNow >= 100;
        await appendCallLog({
          createdAt: Date.now(),
          taskId: "auto_pet_care",
          taskName: `${label} · 抚摸`,
          method: "POST",
          url: patUrl,
          success: ok,
          statusCode: res.status,
          message: ok
            ? `好感 ${moodNow ?? "?"} · 饱腹 ${hungerNow ?? "?"}`
            : st.msg || text.slice(0, 120),
          accountId: account.id,
          accountName: account.name
        });
      } catch (error) {
        await appendCallLog({
          createdAt: Date.now(),
          taskId: "auto_pet_care",
          taskName: `${label} · 抚摸`,
          method: "POST",
          url: patUrl,
          success: false,
          statusCode: null,
          message: String(error).slice(0, 120),
          accountId: account.id,
          accountName: account.name
        });
      }
      await sleep(randomIntInclusive(650, 1550));
      moodOk = moodNow !== null && moodNow >= 100;
    }

    const needFeed =
      moodOk && (hungerNow === null || hungerNow < 100);

    if (needFeed) {
      const feedUrl = `${baseUrl}/api/pet/feed?petId=${encodeURIComponent(petId)}`;
      try {
        const res = await fetch(feedUrl, {
          method: "POST",
          headers,
          body: "{}",
          credentials: "omit",
          mode: "cors",
          referrerPolicy: "strict-origin-when-cross-origin"
        });
        const text = await res.text();
        const st = parsePetDetailFromResponseText(text);
        const ok = res.ok && st.code === 0;
        await appendCallLog({
          createdAt: Date.now(),
          taskId: "auto_pet_care",
          taskName: `${label} · 喂养`,
          method: "POST",
          url: feedUrl,
          success: ok,
          statusCode: res.status,
          message: ok
            ? `好感 ${st.mood ?? "?"} · 饱腹 ${st.hunger ?? "?"}`
            : st.msg || text.slice(0, 120),
          accountId: account.id,
          accountName: account.name
        });
      } catch (error) {
        await appendCallLog({
          createdAt: Date.now(),
          taskId: "auto_pet_care",
          taskName: `${label} · 喂养`,
          method: "POST",
          url: feedUrl,
          success: false,
          statusCode: null,
          message: String(error).slice(0, 120),
          accountId: account.id,
          accountName: account.name
        });
      }
    }

    await petCareDoneReschedule(accountId, manual);
  } catch (error) {
    console.error("宠物自动化:", accountId, error);
    await petCareDoneReschedule(accountId, manual);
  }
}

async function handlePetCareAlarm(alarm) {
  const accountId = alarm.name.startsWith(ROUTINE_ALARM_PET_PREFIX)
    ? alarm.name.slice(ROUTINE_ALARM_PET_PREFIX.length)
    : "";
  if (!accountId) {
    await syncPetCareAlarms();
    return;
  }
  await runPetCareOnce(accountId, false);
}

/**
 * @param {string} accountId
 * @param {boolean} manual 手动：不校验「已开启自动签到」与「今日已记过」
 */
async function executeDailySignInForAccount(accountId, manual) {
  const { accounts } = await loadAccountsBundle();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    return;
  }
  if (!manual && account.autoDailySignInEnabled !== true) {
    return;
  }

  const todayKey = localDayKey();
  if (!manual && account.dailyLastSignInDay === todayKey) {
    return;
  }

  const authHeaders = authHeadersFromAccount(account);
  const baseUrl = await getApiBaseFromStorage();
  const label = manual
    ? `每日自动签到 · ${account.name}（手动）`
    : `每日自动签到 · ${account.name}`;

  if (!authHeaders) {
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_daily_sign_in",
      taskName: label,
      method: "POST",
      url: `${baseUrl}/api/user/signIn`,
      success: false,
      statusCode: null,
      message: "未配置 Token，跳过",
      accountId: account.id,
      accountName: account.name
    });
    await syncDailyRoutineAlarms();
    return;
  }

  const url = `${baseUrl}/api/user/signIn`;
  const headers = buildRedPacketGrabHeaders(authHeaders, baseUrl);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: "{}",
      credentials: "omit",
      mode: "cors",
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    const text = await response.text();
    const { code, msg } = parseJsonCodeMsg(text);
    const httpOk = response.ok;

    let success = false;
    let doneToday = false;
    let summary = msg || text.slice(0, 160);

    if (httpOk && code === 0) {
      let parsedBody;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = null;
      }
      const d = parsedBody?.data;
      if (typeof d === "undefined") {
        success = true;
        doneToday = true;
        summary = "签到成功";
      } else if (d === true) {
        success = true;
        doneToday = true;
        summary = "签到成功";
      } else if (d === false) {
        success = true;
        doneToday = true;
        summary = "今日已签到";
      } else {
        success = true;
        doneToday = true;
        summary = "签到完成";
      }
    }

    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_daily_sign_in",
      taskName: label,
      method: "POST",
      url,
      success,
      statusCode: response.status,
      message: summary.slice(0, 120),
      accountId: account.id,
      accountName: account.name
    });

    if (doneToday) {
      await patchAccountById(accountId, { dailyLastSignInDay: todayKey });
      await syncDailyRoutineAlarms();
      return;
    }

    await chrome.alarms.create(ROUTINE_ALARM_SIGN_IN_PREFIX + accountId, {
      when: Date.now() + randomIntInclusive(12, 28) * 60000
    });
  } catch (error) {
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_daily_sign_in",
      taskName: label,
      method: "POST",
      url,
      success: false,
      statusCode: null,
      message: String(error).slice(0, 120),
      accountId: account.id,
      accountName: account.name
    });
    await chrome.alarms.create(ROUTINE_ALARM_SIGN_IN_PREFIX + accountId, {
      when: Date.now() + randomIntInclusive(10, 25) * 60000
    });
  }
}

async function handleAutoSignInAlarm(alarm) {
  const accountId = alarm.name.startsWith(ROUTINE_ALARM_SIGN_IN_PREFIX)
    ? alarm.name.slice(ROUTINE_ALARM_SIGN_IN_PREFIX.length)
    : "";
  if (!accountId) {
    await syncDailyRoutineAlarms();
    return;
  }
  await executeDailySignInForAccount(accountId, false);
}

/**
 * 通过聊天室 WebSocket 发送公屏消息（与 uTools 一致），不再请求 /api/chat-room/send。
 * 优先复用后台已为抢红包建立的同账号 WS；否则临时建连，发完后关闭。
 * @param {string} clientStr 保留与旧调用兼容（HTTP 时代写入 client 字段）；当前 WS 帧不携带该字段。
 */
async function sendChatRoomMessageOnce(accountId, account, content, clientStr) {
  void clientStr;
  const storage = await chrome.storage.local.get([STORAGE_KEYS.AUTO_RED_PACKET_WS_URL]);
  const wsUrlTemplate =
    storage[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] || DEFAULT_WS_URL_TEMPLATE;
  const token = String(account?.token || "").trim();
  const wsUrl = token ? buildWsUrl(wsUrlTemplate, token) : "";
  const logUrl = maskWsUrlForLog(wsUrl) || maskWsUrlForLog(buildWsUrl(wsUrlTemplate, "***"));

  if (!token || !wsUrl) {
    return {
      apiOk: false,
      httpOk: false,
      status: null,
      summary: !token ? "无 Token" : "WS 地址配置无效",
      logUrl
    };
  }

  const loginRes = await fetchLoginUserForChatWs(account);
  if (!loginRes.ok || !loginRes.user) {
    return {
      apiOk: false,
      httpOk: false,
      status: null,
      summary: `拉取登录用户失败，未发 WS: ${loginRes.error || "未知"}`.slice(0, 200),
      logUrl
    };
  }

  let payload;
  try {
    payload = buildChatRoomWebSocketText(content, loginRes.user);
  } catch (e) {
    return {
      apiOk: false,
      httpOk: false,
      status: null,
      summary: String(e).slice(0, 200),
      logUrl
    };
  }

  const existing = wsClientsByAccountId.get(accountId);
  if (existing && existing.readyState === WebSocket.OPEN) {
    try {
      existing.send(payload);
      return {
        apiOk: true,
        httpOk: true,
        status: 101,
        summary: "WS 帧已发出（身份已与 /api/user/get/login 对齐；是否落库以聊天室为准）",
        logUrl
      };
    } catch (e) {
      return {
        apiOk: false,
        httpOk: false,
        status: null,
        summary: String(e).slice(0, 160),
        logUrl
      };
    }
  }

  return await new Promise((resolve) => {
    let ws;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve({ ...result, logUrl });
    };

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      resolve({
        apiOk: false,
        httpOk: false,
        status: null,
        summary: String(e).slice(0, 160),
        logUrl
      });
      return;
    }

    timer = setTimeout(() => {
      finish({
        apiOk: false,
        httpOk: false,
        status: null,
        summary: "WebSocket 连接超时"
      });
    }, 18000);

    ws.addEventListener("open", () => {
      void (async () => {
        try {
          ws.send(JSON.stringify({ type: 1 }));
          await sleep(randomIntInclusive(80, 320));
          ws.send(payload);
          await sleep(280);
          finish({
            apiOk: true,
            httpOk: true,
            status: 101,
            summary: "WS 帧已发出（身份已与 /api/user/get/login 对齐；是否落库以聊天室为准）"
          });
        } catch (e) {
          finish({
            apiOk: false,
            httpOk: false,
            status: null,
            summary: String(e).slice(0, 160)
          });
        }
      })();
    });

    ws.addEventListener("error", () => {
      finish({
        apiOk: false,
        httpOk: false,
        status: null,
        summary: "WebSocket 连接错误"
      });
    });
  });
}

async function runDailyChatRoutineJobForAccount(accountId, options = {}) {
  const manual = options.manual === true;
  if (chatRoutineBusyAccountIds.has(accountId)) {
    return;
  }
  chatRoutineBusyAccountIds.add(accountId);
  try {
    const { accounts } = await loadAccountsBundle();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      return;
    }
    if (!manual && account.autoDailyChatEnabled !== true) {
      await syncDailyRoutineAlarms();
      return;
    }

    const todayKey = localDayKey();
    if (!manual && account.dailyLastChatRoutineDay === todayKey) {
      await syncDailyRoutineAlarms();
      return;
    }
    if (manual && account.dailyLastChatRoutineDay === todayKey) {
      await appendCallLog({
        createdAt: Date.now(),
        taskId: "auto_daily_chat",
        taskName: `每日自动发言 · ${account.name}（手动）`,
        method: "WS",
        url: "(未发送)",
        success: false,
        statusCode: null,
        message: "今日 20 条发言已完成，未重复发送",
        accountId: account.id,
        accountName: account.name
      });
      return;
    }

    const authHeaders = authHeadersFromAccount(account);
    const label = manual
      ? `每日自动发言 · ${account.name}（手动）`
      : `每日自动发言 · ${account.name}`;

    if (!authHeaders) {
      await appendCallLog({
        createdAt: Date.now(),
        taskId: "auto_daily_chat",
        taskName: label,
        method: "WS",
        url: "聊天室 WS（未配置 Token）",
        success: false,
        statusCode: null,
        message: "未配置 Token，跳过",
        accountId: account.id,
        accountName: account.name
      });
      await syncDailyRoutineAlarms();
      return;
    }

    const clientStr =
      String(account.autoDailyChatClient || "").trim() || DEFAULT_CHAT_CLIENT;

    let st = account.dailyChatState;
    if (!st || typeof st !== "object" || st.dayKey !== todayKey) {
      st = { dayKey: todayKey, nextIndex: 1 };
      await patchAccountById(accountId, { dailyChatState: st });
    }

    let nextIndex = Number(st.nextIndex) || 1;
    if (nextIndex < 1) {
      nextIndex = 1;
    }

    for (let i = nextIndex; i <= 20; i += 1) {
      const content = String(i);
      const { apiOk, status, summary, logUrl } = await sendChatRoomMessageOnce(
        account.id,
        account,
        content,
        clientStr
      );

      await appendCallLog({
        createdAt: Date.now(),
        taskId: "auto_daily_chat",
        taskName: label,
        method: "WS",
        url: logUrl || "聊天室 WS",
        success: apiOk,
        statusCode: status,
        message: `${content}: ${summary.slice(0, 100)}`,
        accountId: account.id,
        accountName: account.name
      });

      if (!apiOk) {
        await patchAccountById(accountId, {
          dailyChatState: { dayKey: todayKey, nextIndex: i }
        });
        await chrome.alarms.create(ROUTINE_ALARM_CHAT_PREFIX + accountId, {
          when: Date.now() + randomIntInclusive(10, 22) * 60000
        });
        return;
      }

      await patchAccountById(accountId, {
        dailyChatState: { dayKey: todayKey, nextIndex: i + 1 }
      });

      if (i < 20) {
        await sleep(randomIntInclusive(22000, 130000));
      }
    }

    await patchAccountById(accountId, {
      dailyLastChatRoutineDay: todayKey,
      dailyChatState: null
    });
    await syncDailyRoutineAlarms();
  } finally {
    chatRoutineBusyAccountIds.delete(accountId);
  }
}

async function handleAutoChatBatchAlarm(alarm) {
  const accountId = alarm.name.startsWith(ROUTINE_ALARM_CHAT_PREFIX)
    ? alarm.name.slice(ROUTINE_ALARM_CHAT_PREFIX.length)
    : "";
  if (!accountId) {
    await syncDailyRoutineAlarms();
    return;
  }
  if (chatRoutineBusyAccountIds.has(accountId)) {
    await chrome.alarms.create(ROUTINE_ALARM_CHAT_PREFIX + accountId, {
      when: Date.now() + randomIntInclusive(25000, 95000)
    });
    return;
  }
  await runDailyChatRoutineJobForAccount(accountId);
}

async function processDueTasks() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.TASKS]);
  const tasks = data[STORAGE_KEYS.TASKS] || [];
  const { ids: taskAccountIds } = await resolveFeatureAccountIds(
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS,
    STORAGE_KEYS.FEATURE_TASK_ACCOUNT_ID
  );

  if (!tasks.length || !taskAccountIds.length) {
    return;
  }

  const now = Date.now();
  let changed = false;
  const updatedTasks = [...tasks];

  for (let i = 0; i < updatedTasks.length; i += 1) {
    const task = updatedTasks[i];
    const intervalSeconds = Number(task.intervalSeconds || task.intervalMinutes * 60 || 0);
    const nextRunAt = Number(task.nextRunAt || 0);

    if (!task.id || !task.url || intervalSeconds < 1) {
      continue;
    }

    if (!nextRunAt || now >= nextRunAt) {
      const method = (task.method || "GET").toUpperCase();

      for (let ai = 0; ai < taskAccountIds.length; ai += 1) {
        const accId = taskAccountIds[ai];
        const acc = await getAccountById(accId);
        const authHeaders = authHeadersFromAccount(acc);
      const headers = {};
        if (authHeaders) {
          Object.assign(headers, authHeaders);
      }

      try {
        const response = await fetch(task.url, { method, headers });
        const text = await response.text();
        const message = text.slice(0, 120);

        await appendCallLog({
          createdAt: now,
          taskId: task.id,
            taskName: `${task.name} · ${acc?.name || "?"}`,
          method,
          url: task.url,
          success: response.ok,
          statusCode: response.status,
            message,
            accountId: acc?.id || accId,
            accountName: acc?.name || ""
        });
          console.log(
            `✅ 任务[${task.name}]账号[${acc?.name}]调用完成，状态码: ${response.status}`
          );
      } catch (error) {
        await appendCallLog({
          createdAt: now,
          taskId: task.id,
            taskName: `${task.name} · ${acc?.name || "?"}`,
          method,
          url: task.url,
          success: false,
          statusCode: null,
            message: String(error).slice(0, 120),
            accountId: acc?.id || accId,
            accountName: acc?.name || ""
        });
        console.error(`❌ 任务[${task.name}]调用失败:`, error);
        }

        if (ai < taskAccountIds.length - 1) {
          await sleep(randomIntInclusive(120, 520));
        }
      }

      updatedTasks[i] = {
        ...task,
        method,
        intervalSeconds,
        nextRunAt: now + intervalSeconds * 1000
      };
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: updatedTasks });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.AUTO_RED_PACKET_WS_URL,
    STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL
  ]);
  const patch = {};
  if (!data[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL]) {
    patch[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] = DEFAULT_WS_URL_TEMPLATE;
  }
  if (!data[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL]) {
    patch[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL] = DEFAULT_API_BASE_URL;
  }
  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
  await syncTaskAlarms();
  await ensureWsAutoGrabConnection();
  await syncDailyRoutineAlarms();
  await syncPetCareAlarms();
  console.log("✅ 插件初始化完成，任务调度已同步");
});

chrome.runtime.onStartup.addListener(async () => {
  await syncTaskAlarms();
  await ensureWsAutoGrabConnection();
  await syncDailyRoutineAlarms();
  await syncPetCareAlarms();
  console.log("✅ 浏览器启动，任务调度已恢复");
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[STORAGE_KEYS.TASKS]) {
    await syncTaskAlarms();
  }
  if (
    changes[STORAGE_KEYS.TOKEN] ||
    changes[STORAGE_KEYS.TOKEN_HEADER_NAME] ||
    changes[STORAGE_KEYS.ACCOUNTS] ||
    changes[STORAGE_KEYS.ACTIVE_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_TASK_ACCOUNT_IDS] ||
    changes[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_REDPACKET_ACCOUNT_IDS] ||
    changes[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_ID] ||
    changes[STORAGE_KEYS.FEATURE_DAILY_EDITOR_ACCOUNT_IDS] ||
    changes[STORAGE_KEYS.AUTO_RED_PACKET] ||
    changes[STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED] ||
    changes[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] ||
    changes[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL]
  ) {
    await ensureWsAutoGrabConnection();
    await syncDailyRoutineAlarms();
    await syncPetCareAlarms();
  }
  if (changes[STORAGE_KEYS.AUTO_PET_CARE_INTERVAL_MINUTES]) {
    await syncPetCareAlarms({ forceReschedule: true });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SCHEDULER_ALARM) {
    await processDueTasks();
    return;
  }
  if (alarm.name.startsWith(ROUTINE_ALARM_SIGN_IN_PREFIX)) {
    await handleAutoSignInAlarm(alarm);
    return;
  }
  if (alarm.name.startsWith(ROUTINE_ALARM_CHAT_PREFIX)) {
    await handleAutoChatBatchAlarm(alarm);
    return;
  }
  if (alarm.name.startsWith(ROUTINE_ALARM_PET_PREFIX)) {
    await handlePetCareAlarm(alarm);
    return;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "AUTO_RED_PACKET_CANDIDATE") {
    (async () => {
      await tryAutoGrabRedPacket({
        redPacketId: String(message.redPacketId || "").trim()
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "RUN_DAILY_ROUTINE_NOW") {
    (async () => {
      const ids = Array.isArray(message.accountIds)
        ? [
            ...new Set(
              message.accountIds.map((x) => String(x || "").trim()).filter(Boolean)
            )
          ]
        : [];
      if (!ids.length) {
        sendResponse({ ok: false, error: "未选择账号" });
        return;
      }
      for (const id of ids) {
        try {
          await executeDailySignInForAccount(id, true);
        } catch (e) {
          console.error("立即签到", id, e);
        }
        await sleep(randomIntInclusive(180, 520));
      }
      for (const id of ids) {
        void runDailyChatRoutineJobForAccount(id, { manual: true });
      }
      sendResponse({
        ok: true,
        message: `已对 ${ids.length} 个账号尝试签到；发言任务已在后台开始（今日已发完的会跳过）`
      });
    })();
    return true;
  }

  if (message.type === "FETCH_ACCOUNT_PET_ID") {
    (async () => {
      const accountId = String(message.accountId || "").trim();
      const result = await fetchMyPetIdForAccount(accountId, {
        token: message.token,
        tokenHeaderName: message.tokenHeaderName
      });
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === "RUN_PET_CARE_NOW") {
    (async () => {
      const ids = Array.isArray(message.accountIds)
        ? [
            ...new Set(
              message.accountIds.map((x) => String(x || "").trim()).filter(Boolean)
            )
          ]
        : [];
      if (!ids.length) {
        sendResponse({ ok: false, error: "未选择账号" });
        return;
      }
      for (const id of ids) {
        try {
          await runPetCareOnce(id, true);
        } catch (e) {
          console.error("立即宠物护理", id, e);
        }
        await sleep(randomIntInclusive(320, 900));
      }
      sendResponse({
        ok: true,
        message: `已对 ${ids.length} 个账号执行宠物查询/抚摸/喂养`
      });
    })();
    return true;
  }

  return;
});

ensureWsAutoGrabConnection();
void syncDailyRoutineAlarms();
void syncPetCareAlarms();