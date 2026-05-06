(function () {
  const BRIDGE_SOURCE = "api_plugin_ws_bridge";
  const redPacketPattern = /\[redpacket\]\s*([\s\S]*?)\s*\[\/redpacket\]/gi;
  const seenIds = new Set();

  function emitRedPacketId(rawId) {
    const redPacketId = String(rawId || "").trim();
    if (!redPacketId || seenIds.has(redPacketId)) return;
    seenIds.add(redPacketId);
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "RED_PACKET_FOUND",
        redPacketId
      },
      "*"
    );
  }

  function scanString(content) {
    if (!content || typeof content !== "string") return;
    redPacketPattern.lastIndex = 0;
    let match = redPacketPattern.exec(content);
    while (match) {
      const captured = String(match[1] || "").trim();
      if (captured) {
        try {
          const parsed = JSON.parse(captured);
          if (parsed && typeof parsed === "object" && parsed.id != null) {
            emitRedPacketId(parsed.id);
          } else {
            emitRedPacketId(captured);
          }
        } catch {
          emitRedPacketId(captured);
        }
      }
      match = redPacketPattern.exec(content);
    }
  }

  function deepScan(payload) {
    if (payload == null) return;
    if (typeof payload === "string") {
      scanString(payload);
      try {
        deepScan(JSON.parse(payload));
      } catch {
        // ignore
      }
      return;
    }

    if (Array.isArray(payload)) {
      payload.forEach(deepScan);
      return;
    }

    if (typeof payload === "object") {
      Object.values(payload).forEach(deepScan);
    }
  }

  function handleMessageEvent(event) {
    try {
      deepScan(event && event.data);
    } catch {
      // ignore
    }
  }

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;

  function WrappedWebSocket(...args) {
    const ws = new NativeWebSocket(...args);
    ws.addEventListener("message", handleMessageEvent);

    const nativeSetter = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, "onmessage");
    if (nativeSetter && nativeSetter.set && nativeSetter.get) {
      let assigned = null;
      Object.defineProperty(ws, "onmessage", {
        configurable: true,
        enumerable: true,
        get() {
          return assigned;
        },
        set(handler) {
          assigned = handler;
          nativeSetter.set.call(ws, function (event) {
            handleMessageEvent(event);
            if (typeof handler === "function") {
              return handler.call(this, event);
            }
            return undefined;
          });
        }
      });
    }

    return ws;
  }

  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
  window.WebSocket = WrappedWebSocket;
})();

