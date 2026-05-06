const BRIDGE_SOURCE = "api_plugin_ws_bridge";

function injectHookScript() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("ws-hook.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (error) {
    console.error("注入 WebSocket Hook 失败:", error);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== BRIDGE_SOURCE || data.type !== "RED_PACKET_FOUND") {
    return;
  }

  chrome.runtime.sendMessage({
    type: "AUTO_RED_PACKET_CANDIDATE",
    redPacketId: String(data.redPacketId || "").trim(),
    pageOrigin: location.origin
  });
});

injectHookScript();

