const STORAGE_KEYS = {
  TOKEN: "api_token",
  TASKS: "api_tasks",
  LOGS: "api_call_logs",
  AUTO_RED_PACKET: "auto_red_packet_enabled",
  AUTO_RED_PACKET_CLAIMED_IDS: "auto_red_packet_claimed_ids",
  AUTO_RED_PACKET_WS_ENABLED: "auto_red_packet_ws_enabled",
  AUTO_RED_PACKET_WS_URL: "auto_red_packet_ws_url",
  AUTO_RED_PACKET_API_BASE_URL: "auto_red_packet_api_base_url",
  WS_MESSAGES: "ws_messages",
  RED_PACKET_GRAB_LOGS: "red_packet_grab_logs"
};

const SCHEDULER_ALARM = "api_scheduler_tick";
const SCHEDULER_PERIOD_MINUTES = 0.5;
const MAX_LOG_COUNT = 100;
const MAX_RED_PACKET_CACHE_SIZE = 200;
const MAX_WS_MESSAGE_COUNT = 200;
const MAX_WS_MESSAGE_CHARS = 8000;
const MAX_RED_PACKET_GRAB_LOGS = 150;
const DEFAULT_WS_URL_TEMPLATE = "wss://api.yucoder.cn/ws/?token={token}";
const DEFAULT_API_BASE_URL = "https://api.yucoder.cn";

const WS_BRIDGE_PATTERN = /\[redpacket\]\s*([\s\S]*?)\s*\[\/redpacket\]/gi;
let wsClient = null;
let wsReconnectTimer = null;

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

async function appendWsMessageLog(payload) {
  const raw = String(payload || "").slice(0, MAX_WS_MESSAGE_CHARS);
  if (!shouldAppendWsMessage(raw)) {
    return;
  }
  const data = await chrome.storage.local.get(STORAGE_KEYS.WS_MESSAGES);
  const logs = data[STORAGE_KEYS.WS_MESSAGES] || [];
  logs.unshift({
    createdAt: Date.now(),
    message: raw
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

async function markRedPacketClaimed(redPacketId) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS);
  const existed = data[STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS] || [];
  const deduped = [redPacketId, ...existed.filter((id) => id !== redPacketId)];
  if (deduped.length > MAX_RED_PACKET_CACHE_SIZE) {
    deduped.length = MAX_RED_PACKET_CACHE_SIZE;
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS]: deduped
  });
}

async function hasRedPacketBeenClaimed(redPacketId) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS);
  const existed = data[STORAGE_KEYS.AUTO_RED_PACKET_CLAIMED_IDS] || [];
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

async function tryAutoGrabRedPacket({ redPacketId }) {
  if (!redPacketId) return;

  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.TOKEN,
    STORAGE_KEYS.AUTO_RED_PACKET,
    STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL
  ]);
  const token = storage[STORAGE_KEYS.TOKEN] || "";
  const autoEnabled = storage[STORAGE_KEYS.AUTO_RED_PACKET] !== false;
  const baseUrl = normalizeApiBaseUrl(
    storage[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL] || DEFAULT_API_BASE_URL
  );

  if (!autoEnabled || !token) return;
  if (await hasRedPacketBeenClaimed(redPacketId)) return;

  const url = `${baseUrl}/api/redpacket/grab?redPacketId=${encodeURIComponent(redPacketId)}`;
  const now = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      }
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
      message: summaryMsg
    });

    await appendCallLog({
      createdAt: now,
      taskId: "auto_red_packet",
      taskName: "自动抢红包",
      method: "POST",
      url,
      success,
      statusCode: response.status,
      message: success ? `抢到 ${amount} 积分` : summaryMsg.slice(0, 120)
    });

    await markRedPacketClaimed(redPacketId);
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
      message: errText
    });
    await appendCallLog({
      createdAt: now,
      taskId: "auto_red_packet",
      taskName: "自动抢红包",
      method: "POST",
      url,
      success: false,
      statusCode: null,
      message: errText.slice(0, 120)
    });
    console.error("🧧 自动抢红包失败:", error);
  }
}

function clearWsReconnectTimer() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function scheduleWsReconnect() {
  clearWsReconnectTimer();
  wsReconnectTimer = setTimeout(() => {
    ensureWsAutoGrabConnection();
  }, 5000);
}

function closeWsClient() {
  clearWsReconnectTimer();
  if (wsClient) {
    try {
      wsClient.close();
    } catch {
      // ignore
    }
    wsClient = null;
  }
}

async function ensureWsAutoGrabConnection() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TOKEN,
    STORAGE_KEYS.AUTO_RED_PACKET,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_URL,
    STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL
  ]);
  const token = data[STORAGE_KEYS.TOKEN] || "";
  const autoEnabled = data[STORAGE_KEYS.AUTO_RED_PACKET] !== false;
  const wsEnabled = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED] !== false;
  const wsUrlTemplate = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] || DEFAULT_WS_URL_TEMPLATE;
  if (!autoEnabled || !wsEnabled || !token) {
    closeWsClient();
    return;
  }

  if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = buildWsUrl(wsUrlTemplate, token);
  if (!wsUrl) return;

  closeWsClient();

  try {
    wsClient = new WebSocket(wsUrl);
  } catch (error) {
    console.error("WebSocket 创建失败:", error);
    scheduleWsReconnect();
    return;
  }

  wsClient.addEventListener("open", async () => {
    clearWsReconnectTimer();
    console.log("🧧 自动抢红包 WS 已连接");
    try {
      wsClient.send(JSON.stringify({ type: 1 }));
    } catch {
      // ignore
    }
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_red_packet_ws",
      taskName: "自动抢红包WS",
      method: "WS",
      url: wsUrl,
      success: true,
      statusCode: 101,
      message: "WebSocket connected"
    });
  });

  wsClient.addEventListener("message", (event) => {
    appendWsMessageLog(event?.data);
    deepScanForRedPacket(event?.data, (candidateId) => {
      tryAutoGrabRedPacket({
        redPacketId: candidateId
      });
    });
  });

  wsClient.addEventListener("error", async () => {
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_red_packet_ws",
      taskName: "自动抢红包WS",
      method: "WS",
      url: wsUrl,
      success: false,
      statusCode: null,
      message: "WebSocket error"
    });
  });

  wsClient.addEventListener("close", async () => {
    await appendCallLog({
      createdAt: Date.now(),
      taskId: "auto_red_packet_ws",
      taskName: "自动抢红包WS",
      method: "WS",
      url: wsUrl,
      success: false,
      statusCode: null,
      message: "WebSocket closed, reconnecting"
    });
    wsClient = null;
    scheduleWsReconnect();
  });
}

async function processDueTasks() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TOKEN,
    STORAGE_KEYS.TASKS
  ]);
  const token = data[STORAGE_KEYS.TOKEN] || "";
  const tasks = data[STORAGE_KEYS.TASKS] || [];

  if (!tasks.length) {
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
      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      try {
        const response = await fetch(task.url, { method, headers });
        const text = await response.text();
        const message = text.slice(0, 120);

        await appendCallLog({
          createdAt: now,
          taskId: task.id,
          taskName: task.name,
          method,
          url: task.url,
          success: response.ok,
          statusCode: response.status,
          message
        });
        console.log(`✅ 任务[${task.name}]调用完成，状态码: ${response.status}`);
      } catch (error) {
        await appendCallLog({
          createdAt: now,
          taskId: task.id,
          taskName: task.name,
          method,
          url: task.url,
          success: false,
          statusCode: null,
          message: String(error).slice(0, 120)
        });
        console.error(`❌ 任务[${task.name}]调用失败:`, error);
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
  console.log("✅ 插件初始化完成，任务调度已同步");
});

chrome.runtime.onStartup.addListener(async () => {
  await syncTaskAlarms();
  await ensureWsAutoGrabConnection();
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
    changes[STORAGE_KEYS.AUTO_RED_PACKET] ||
    changes[STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED] ||
    changes[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] ||
    changes[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL]
  ) {
    await ensureWsAutoGrabConnection();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SCHEDULER_ALARM) {
    return;
  }
  await processDueTasks();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "AUTO_RED_PACKET_CANDIDATE") {
    return;
  }

  (async () => {
    await tryAutoGrabRedPacket({
      redPacketId: String(message.redPacketId || "").trim()
    });
    sendResponse({ ok: true });
  })();

  return true;
});

ensureWsAutoGrabConnection();