/**
 * TeamTalk5 Connection Service
 *
 * Browsers cannot open raw TCP/UDP sockets, which TeamTalk5 requires.
 * This service connects to a WebSocket bridge server that translates
 * between WebSocket (browser) and raw TCP/UDP (TeamTalk5 server).
 *
 * BRIDGE SETUP:
 * A ready-to-deploy bridge lives in the `bridge/` folder of this project
 * (Python / FastAPI / teamtalk.py, with Render + Docker files). Deploy it,
 * then paste your WSS URL below — e.g. "wss://your-svc.onrender.com/ws".
 * See bridge/README.md for the step-by-step Render deploy.
 *
 * Protocol (JSON messages over WebSocket):
 * → { type: "connect", domain, tcp_port, udp_port, username, password, nickname, room }
 * ← { type: "connected", users: [{id, nickname}] }
 * ← { type: "user_joined", user: {id, nickname} }
 * ← { type: "user_left", user: {id} }
 * ← { type: "channel_message", from: {id, nickname}, text }
 * ← { type: "dm", from: {id, nickname}, text }
 * → { type: "channel_message", text }
 * → { type: "dm", to_user_id, text }
 * → { type: "disconnect" }
 * ← { type: "disconnected" }
 * ← { type: "error", message }
 */

// ─── Bridge Configuration ───────────────────────────────────────────
// Change this to your deployed WebSocket bridge server URL.
// Example: "wss://my-tt5-bridge.example.com/ws"
const BRIDGE_URL = "wss://techno-notify.onrender.com/ws";

export function getBridgeUrl() {
  return (
    (typeof window !== "undefined" && window.TT5_BRIDGE_URL) ||
    BRIDGE_URL
  );
}

export function isBridgeConfigured() {
  return Boolean(getBridgeUrl());
}

// ─── Connection Class ───────────────────────────────────────────────
export class TT5Connection {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
    return () => {
      const arr = this.listeners.get(event);
      const i = arr.indexOf(callback);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  _emit(event, data) {
    const arr = this.listeners.get(event);
    if (arr) arr.forEach((cb) => cb(data));
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /**
   * Connect to a TeamTalk5 server via the bridge.
   * @param {object} params - { domain, tcp_port, udp_port, username, password, nickname, room }
   */
  connect(params) {
    return new Promise((resolve, reject) => {
      const bridgeUrl = getBridgeUrl();
      if (!bridgeUrl) {
        reject(
          new Error(
            "NO_BRIDGE_CONFIGURED: No WebSocket bridge URL is set. " +
              "Deploy a TeamTalk5 WebSocket bridge and set the URL in src/lib/tt5Connection.js."
          )
        );
        return;
      }

      try {
        this.ws = new WebSocket(bridgeUrl);
      } catch (e) {
        reject(new Error("Cannot reach bridge server: " + e.message));
        return;
      }

      const timeout = setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Connection timed out. The bridge server may be offline."));
          this._cleanup();
        }
      }, 30000);

      this.ws.onopen = () => {
        this._send({ type: "connect", ...params });
      };

      this.ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "connected") {
          this.connected = true;
          clearTimeout(timeout);
          this._emit("connected", msg);
          resolve(msg);
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          this._emit("error", msg);
          reject(new Error(msg.message || "TeamTalk5 connection error"));
        } else {
          this._emit(msg.type, msg);
        }
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(new Error("Bridge connection failed. Check that your bridge server is running."));
        }
        this._emit("error", { message: "WebSocket error" });
      };

      this.ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        clearTimeout(timeout);
        this._emit("disconnected", {});
        if (!wasConnected) {
          reject(new Error("Bridge connection closed before TeamTalk5 connection completed."));
        }
      };
    });
  }

  sendChannelMessage(text) {
    return this._send({ type: "channel_message", text });
  }

  sendDM(toUserId, text) {
    return this._send({ type: "dm", to_user_id: toUserId, text });
  }

  disconnect() {
    if (this.ws) {
      this._send({ type: "disconnect" });
    }
    this._cleanup();
  }

  _cleanup() {
    this.connected = false;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

// Singleton instance
export const tt5 = new TT5Connection();
