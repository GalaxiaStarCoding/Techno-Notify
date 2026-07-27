"""
TeamTalk5 WebSocket Bridge — "Techno-Notify" backend

A single small server that sits between browsers (which can only speak
WebSocket) and real TeamTalk5 servers (which speak raw TCP/UDP).

Each browser connects and tells us which TeamTalk5 server + room it wants.
We open a TeamTalk5 client for that browser, join the room, and translate
every event into a JSON message over the WebSocket. Browser commands
(channel message, direct message, disconnect) are translated the other way.

This is the matching server side of the protocol documented in
src/lib/tt5Connection.js.

Deploy: see bridge/README.md  (Render is the target, but anything that runs
Python + uvicorn works — Fly.io, Railway, a VPS, etc.)

NOTE: teamtalk.py wraps the official TeamTalk5 C SDK. Its Bot.run() blocks,
so each WebSocket session runs in its own thread:
  - a "pump" thread calls bot.run() and emits events to the WebSocket
  - the session thread reads browser commands and applies them to the bot
TeamTalk5's command API is queued/processed by the pump, so cross-thread
command dispatch is the supported model here. If you hit threading oddities
on your server build, the safest fallback is one *process* per session
instead of threads — but threads keep memory low.
"""

import asyncio
import json
import threading
import queue
import logging

import teamtalk
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("tt5bridge")

app = FastAPI(title="Techno-Notify TT5 Bridge")


@app.get("/health")
def health():
    return {"status": "ok", "service": "techno-notify-tt5-bridge"}


# ──────────────────────────────────────────────────────────────────────────
# One of these threads runs per connected browser session.
# Calls into the teamtalk.py Bot live inside run(), which is the ONLY thread
# that pumps the SDK. Commands from the browser are dispatched from a small
# poller that runs alongside the pump.
# ──────────────────────────────────────────────────────────────────────────
class TT5Session(threading.Thread):
    def __init__(self, connect_data, to_client, cmd_queue, ready_event, error_holder):
        super().__init__(daemon=True)
        self.connect_data = connect_data
        self.to_client = to_client            # queue.Queue[str]  -> browser
        self.cmd_queue = cmd_queue            # queue.Queue[str|None] -> browser commands
        self.ready_event = ready_event        # set when bot is pumping
        self.error_holder = error_holder      # dict for first error str
        self.bot = None
        self.server = None
        self.room_name = (connect_data.get("room") or "").strip()
        self.my_channel = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # send a JSON frame to the browser
    def emit(self, obj):
        self.to_client.put(json.dumps(obj))

    # run inside bot.run()'s thread
    def _on_error(self, event_name, *args, **kwargs):
        log.warning("teamtalk.py event error: %s", event_name)

    def _on_my_login(self, server):
        self.server = server
        channel = self._find_room(server)
        if channel is None:
            self.emit({"type": "error", "message": f"Room '{self.room_name}' not found on this server."})
            try:
                server.disconnect()
            except Exception:
                pass
            return
        try:
            server.join_channel(channel)
        except Exception as e:
            self.emit({"type": "error", "message": f"Could not join room: {e}"})

    def _on_my_disconnect(self, server):
        self.emit({"type": "disconnected"})
        self._stop.set()

    def _on_my_connection_lost(self, instance):
        self.emit({"type": "disconnected"})
        self._stop.set()

    def _find_room(self, server):
        try:
            channels = server.get_channels() or []
        except Exception:
            return None
        # match by name (case-insensitive), top-level or any path
        target = self.room_name.lower()
        for ch in channels:
            name = (getattr(ch, "name", "") or "").lower()
            if name == target:
                return ch
            # also accept "Parent/Child" style
            path = (getattr(ch, "channel_path", "") or "").lower().rstrip("/")
            if path == target or path.endswith("/" + target):
                return ch
        return None

    def _on_user_join(self, user, channel):
        try:
            users = channel.get_users() or []
        except Exception:
            users = []
        users_blob = [self._user_blob(u) for u in users]
        if user.is_me():
            self.my_channel = channel
            self.emit({"type": "connected", "users": users_blob})
        else:
            self.emit({
                "type": "user_joined",
                "user": self._user_blob(user),
                "users": users_blob,
            })

    def _on_user_left(self, user, channel):
        self.emit({"type": "user_left", "user": self._user_blob(user)})

    def _on_message(self, message):
        try:
            user = getattr(message, "user", None)
            is_me = False
            try:
                is_me = message.is_me()
            except Exception:
                pass
            from_id = "self" if is_me else (getattr(user, "user_id", None))
            from_nick = getattr(user, "nickname", "") or ""
            text = getattr(message, "content", "") or ""
            if isinstance(message, teamtalk.DirectMessage):
                self.emit({"type": "dm", "from": {"id": from_id, "nickname": from_nick}, "text": text})
            else:
                self.emit({"type": "channel_message", "from": {"id": from_id, "nickname": from_nick}, "text": text})
        except Exception as e:
            log.warning("on_message translation error: %s", e)

    def _user_blob(self, user):
        uid = getattr(user, "user_id", None)
        nick = getattr(user, "nickname", "") or ""
        if user.is_me():
            uid = "self"
        return {"id": uid, "nickname": nick}

    # ── command dispatch (called from the session thread, not the pump) ──────
    def _send_channel_message(self, text):
        with self._lock:
            if not self.my_channel:
                self.emit({"type": "error", "message": "Not in a room yet."})
                return
            try:
                self.my_channel.send_message(text)
            except Exception as e:
                self.emit({"type": "error", "message": f"Could not send: {e}"})

    def _send_dm(self, to_user_id, text):
        with self._lock:
            if self.server is None:
                self.emit({"type": "error", "message": "Not connected."})
                return
            try:
                user = self.server.get_user(to_user_id)
                if user is None:
                    self.emit({"type": "error", "message": f"User {to_user_id} not found."})
                    return
                user.send_message(text)
            except Exception as e:
                self.emit({"type": "error", "message": f"Could not send DM: {e}"})

    def _do_disconnect(self):
        try:
            if self.server:
                self.server.disconnect()
        except Exception:
            pass
        self._stop.set()

    def run(self):
        try:
            bot = teamtalk.Bot()
            self.bot = bot

            bot.event(self._on_error, "on_error")
            bot.event(self._on_my_login, "on_my_login")
            bot.event(self._on_my_disconnect, "on_my_disconnect")
            bot.event(self._on_my_connection_lost, "on_my_connection_lost")
            bot.event(self._on_user_join, "on_user_join")
            bot.event(self._on_user_left, "on_user_left")
            bot.event(self._on_message, "on_message")

            d = self.connect_data
            bot.add_server(
                d.get("domain", ""),
                int(d.get("tcp_port") or 0),
                int(d.get("udp_port") or 0),
                d.get("username", ""),
                d.get("password") or "",
                nickname=d.get("nickname") or "",
            )

            # signal that the pump is about to start
            self.ready_event.set()

            # bot.run() blocks for the lifetime of this TeamTalk client.
            # Run it in a sub-thread so this thread can pump browser commands.
            pump_thread = threading.Thread(target=bot.run, daemon=True)
            pump_thread.start()

            # command loop
            while not self._stop.is_set():
                try:
                    item = self.cmd_queue.get(timeout=0.25)
                except queue.Empty:
                    continue
                if item is None:
                    break
                try:
                    cmd = json.loads(item)
                except Exception:
                    continue
                ctype = cmd.get("type")
                if ctype == "channel_message":
                    self._send_channel_message(cmd.get("text", "")[:4000])
                elif ctype == "dm":
                    self._send_dm(cmd.get("to_user_id"), cmd.get("text", "")[:4000])
                elif ctype == "disconnect":
                    self._do_disconnect()
                    break

            # graceful shutdown
            try:
                self._do_disconnect()
            except Exception:
                pass
            pump_thread.join(timeout=3)
            self.emit({"type": "disconnected"})
        except Exception as e:
            self.error_holder["error"] = str(e)
            self.ready_event.set()
            try:
                self.emit({"type": "error", "message": str(e)})
            except Exception:
                pass


# ──────────────────────────────────────────────────────────────────────────
# WebSocket endpoint
# ──────────────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    log.info("bridge: WebSocket accepted")

    to_client = queue.Queue()
    cmd_queue = queue.Queue()
    ready_event = threading.Event()
    error_holder = {}

    session = None

    try:
        # 1. wait for the initial "connect" command from the browser
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        data = json.loads(raw)
        if data.get("type") != "connect":
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": "Expected a connect command first.",
            }))
            await websocket.close()
            return

        room = (data.get("room") or "").strip()
        if not room:
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": "A room name is required.",
            }))
            await websocket.close()
            return

        # 2. spin up the TeamTalk session thread
        session = TT5Session(data, to_client, cmd_queue, ready_event, error_holder)
        session.start()
        ready_event.wait(timeout=5)
        if error_holder.get("error"):
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": error_holder["error"],
            }))
            await websocket.close()
            return

        # 3. pump TeamTalk events -> browser
        async def forward_events():
            loop = asyncio.get_event_loop()
            while True:
                try:
                    frame = await loop.run_in_executor(None, to_client.get, True, 0.2)
                except queue.Empty:
                    continue
                if frame is None:
                    break
                try:
                    await websocket.send_text(frame)
                except Exception:
                    break

        fwd = asyncio.create_task(forward_events())

        # 4. pump browser -> TeamTalk commands
        async def receive_commands():
            while True:
                msg = await websocket.receive_text()
                cmd_queue.put(msg)

        recv = asyncio.create_task(receive_commands())

        # the forwarder ends when the session emits a terminal frame
        await fwd
        recv.cancel()
    except WebSocketDisconnect:
        log.info("bridge: browser disconnected")
    except asyncio.TimeoutError:
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": "Timed out waiting for connect command.",
        }))
    except Exception as e:
        log.exception("bridge: error")
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        if session is not None:
            cmd_queue.put(None)
            session.join(timeout=5)
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
