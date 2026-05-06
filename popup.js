const STORAGE_KEYS = {
  TOKEN: "api_token",
  TASKS: "api_tasks",
  LOGS: "api_call_logs",
  AUTO_RED_PACKET: "auto_red_packet_enabled",
  AUTO_RED_PACKET_WS_ENABLED: "auto_red_packet_ws_enabled",
  AUTO_RED_PACKET_WS_URL: "auto_red_packet_ws_url",
  AUTO_RED_PACKET_API_BASE_URL: "auto_red_packet_api_base_url",
  WS_MESSAGES: "ws_messages",
  RED_PACKET_GRAB_LOGS: "red_packet_grab_logs"
};

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
const saveTokenBtn = document.getElementById("saveTokenBtn");
const taskNameInput = document.getElementById("taskNameInput");
const taskUrlInput = document.getElementById("taskUrlInput");
const taskMethodInput = document.getElementById("taskMethodInput");
const taskIntervalInput = document.getElementById("taskIntervalInput");
const addTaskBtn = document.getElementById("addTaskBtn");
const taskList = document.getElementById("taskList");
const statusEl = document.getElementById("status");
const usePageTokenBtn = document.getElementById("usePageTokenBtn");
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

  const logs = Array.isArray(grabLogs) ? grabLogs : [];
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

  const logs = Array.isArray(grabLogs) ? grabLogs : [];
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
    item.innerHTML = `
      <div class="task-title">${log.success ? "✅" : "❌"} ${headline}</div>
      <div class="task-meta">红包 ID：${log.redPacketId || "-"} · ${createdAt}</div>
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

  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "task-meta";
    empty.textContent = "暂无调用记录";
    logsList.appendChild(empty);
    return;
  }

  logs.forEach((log) => {
    const item = document.createElement("div");
    item.className = "log-item";
    const createdAt = new Date(log.createdAt).toLocaleString();

    item.innerHTML = `
      <div class="task-title">${log.success ? "✅" : "❌"} ${log.taskName || "未知任务"}</div>
      <div class="task-meta">${createdAt}</div>
      <div class="task-meta">方法: ${log.method || "GET"}</div>
      <div class="task-meta">状态: ${log.statusCode ?? "-"}</div>
      <div class="task-meta">${log.url || ""}</div>
      <div class="task-meta">${log.message || ""}</div>
    `;

    logsList.appendChild(item);
  });
}

function renderWsMessages(messages) {
  wsMessagesList.innerHTML = "";

  const raw = Array.isArray(messages) ? messages : [];

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
    row.innerHTML = `
      <div class="chat-log-header">
        <span class="chat-log-time">${createdAt}</span>
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

async function loadData() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TOKEN,
    STORAGE_KEYS.TASKS,
    STORAGE_KEYS.LOGS,
    STORAGE_KEYS.WS_MESSAGES,
    STORAGE_KEYS.AUTO_RED_PACKET,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED,
    STORAGE_KEYS.AUTO_RED_PACKET_WS_URL,
    STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL,
    STORAGE_KEYS.RED_PACKET_GRAB_LOGS
  ]);

  tokenInput.value = data[STORAGE_KEYS.TOKEN] || "";
  const tasks = data[STORAGE_KEYS.TASKS] || [];
  const logs = data[STORAGE_KEYS.LOGS] || [];
  const wsMessages = data[STORAGE_KEYS.WS_MESSAGES] || [];
  const grabLogs = data[STORAGE_KEYS.RED_PACKET_GRAB_LOGS] || [];
  autoRedPacketInput.checked = data[STORAGE_KEYS.AUTO_RED_PACKET] !== false;
  wsAutoGrabInput.checked = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED] !== false;
  wsUrlInput.value = data[STORAGE_KEYS.AUTO_RED_PACKET_WS_URL] || "wss://api.yucoder.cn/ws/?token={token}";
  apiBaseUrlInput.value = data[STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL] || "https://api.yucoder.cn";
  renderTasks(tasks);
  renderLogs(logs);
  renderDailyStats(grabLogs);
  renderGrabLogs(grabLogs);
  renderWsMessages(wsMessages);
}

saveTokenBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ [STORAGE_KEYS.TOKEN]: token });
  showStatus("Token 已保存");
});

usePageTokenBtn.addEventListener("click", async () => {
  const tokenValue = await fetchCurrentPageToken();
  if (!tokenValue) {
    showStatus("当前网页没有可用的 tokenValue", true);
    return;
  }

  tokenInput.value = tokenValue;
  await chrome.storage.local.set({ [STORAGE_KEYS.TOKEN]: tokenValue });
  showStatus("已使用并保存当前网页 tokenValue");
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

saveAutoGrabSettingsBtn.addEventListener("click", async () => {
  const wsUrl = wsUrlInput.value.trim();
  const apiBaseUrl = apiBaseUrlInput.value.trim();
  const wsEnabled = wsAutoGrabInput.checked;

  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED]: wsEnabled
  });

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

  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTO_RED_PACKET_WS_ENABLED]: wsEnabled,
    [STORAGE_KEYS.AUTO_RED_PACKET_WS_URL]: wsUrl,
    [STORAGE_KEYS.AUTO_RED_PACKET_API_BASE_URL]: parsedBaseUrl.toString().replace(/\/+$/, "")
  });

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
  const data = await chrome.storage.local.get(STORAGE_KEYS.LOGS);
  const logs = data[STORAGE_KEYS.LOGS] || [];
  renderLogs(logs);
  showStatus("已刷新调用记录");
});
refreshWsMessagesBtn.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.WS_MESSAGES);
  const wsMessages = data[STORAGE_KEYS.WS_MESSAGES] || [];
  renderWsMessages(wsMessages);
  showStatus("已刷新聊天室 WS");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEYS.WS_MESSAGES]) {
    const next = changes[STORAGE_KEYS.WS_MESSAGES].newValue || [];
    renderWsMessages(next);
  }
  if (changes[STORAGE_KEYS.RED_PACKET_GRAB_LOGS]) {
    const next = changes[STORAGE_KEYS.RED_PACKET_GRAB_LOGS].newValue || [];
    renderDailyStats(next);
    renderGrabLogs(next);
  }
});

configTabBtn.addEventListener("click", () => switchTab("config"));
logsTabBtn.addEventListener("click", () => switchTab("logs"));

document.addEventListener("DOMContentLoaded", loadData);
