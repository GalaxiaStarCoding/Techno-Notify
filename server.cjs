const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const net = require("net");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

const PORT = process.env.PORT || 10000;

const CONFIG = {
    host: process.env.TT_HOST || "127.0.0.1",
    port: parseInt(process.env.TT_PORT || "10333"),
    username: process.env.TT_USERNAME || "NotifyBot",
    password: process.env.TT_PASSWORD || "",
    nickname: process.env.TT_NICKNAME || "Techno Notify",
    channel: process.env.TT_CHANNEL || ""
};

let ttSocket = null;
let connected = false;
let reconnecting = false;

const state = {
    users: {},
    channels: {},
    stats: {
        messages: 0,
        joins: 0,
        leaves: 0,
        startTime: Date.now()
    }
};

function uptime() {
    return Math.floor((Date.now() - state.stats.startTime) / 1000);
}

function broadcast(type, data) {
    const payload = JSON.stringify({ type, data });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function send(command) {
    if (!connected || !ttSocket) return;
    ttSocket.write(command + "\r\n");
    console.log("> " + command);
}

function parseParams(str) {
    const params = {};
    const regex = /([a-zA-Z0-9_]+)="([^"]*)"|([a-zA-Z0-9_]+)=([^ ]+)/g;
    let match;

    while ((match = regex.exec(str)) !== null) {
        if (match[1]) {
            params[match[1]] = match[2];
        } else {
            params[match[3]] = match[4];
        }
    }

    return params;
}

function handleLine(line) {
    line = line.trim();
    if (!line) return;

    console.log(line);

    const [command, ...rest] = line.split(" ");
    const params = parseParams(rest.join(" "));

    broadcast("raw", line);

    switch (command) {

        case "loggedin":
            console.log("TeamTalk login successful.");
            broadcast("login", params);

            if (CONFIG.channel) {
                setTimeout(() => {
                    send(`join chanpath="${CONFIG.channel}"`);
                }, 500);
            }
            break;

        case "joined":
            console.log("Joined channel.");
            broadcast("channelJoined", params);
            break;

        case "adduser":
            state.users[params.userid] = params;
            state.stats.joins++;

            broadcast("userJoined", {
                userid: params.userid,
                nickname: params.nickname,
                channelid: params.channelid
            });
            break;

        case "removeuser":
            delete state.users[params.userid];
            state.stats.leaves++;

            broadcast("userLeft", {
                userid: params.userid,
                channelid: params.channelid
            });
            break;

        case "messagedeliver":
            state.stats.messages++;

            broadcast("message", {
                from: params.srcuserid,
                to: params.destuserid,
                channelid: params.channelid,
                content: params.content
            });
            break;

        case "addchannel":
            state.channels[params.channelid] = params;

            broadcast("channelAdded", {
                channelid: params.channelid,
                name: params.name,
                parentid: params.parentid
            });
            break;

        case "removechannel":
            delete state.channels[params.channelid];

            broadcast("channelRemoved", {
                channelid: params.channelid
            });
            break;

        case "serverupdate":
            broadcast("serverUpdate", params);
            break;

        case "pong":
            break;

        default:
            broadcast("event", {
                command,
                params
            });
    }
}

function connectTeamTalk() {
    console.log("Connecting to TeamTalk...");

    ttSocket = new net.Socket();

    ttSocket.connect(CONFIG.port, CONFIG.host);

    ttSocket.on("connect", () => {
        connected = true;
        reconnecting = false;

        console.log("Connected to TeamTalk.");

        send(
            `login username="${CONFIG.username}" password="${CONFIG.password}" nickname="${CONFIG.nickname}" clientname="Techno Notify" protocol="5.18"`
        );

        broadcast("connected", {
            host: CONFIG.host,
            port: CONFIG.port
        });
    });

    ttSocket.on("data", buffer => {
        const lines = buffer.toString().split(/\r?\n/);
        lines.forEach(handleLine);
    });

    ttSocket.on("close", () => {
        connected = false;

        console.log("TeamTalk connection closed.");

        broadcast("disconnected", {});

        if (!reconnecting) {
            reconnecting = true;

            setTimeout(() => {
                connectTeamTalk();
            }, 5000);
        }
    });

    ttSocket.on("error", err => {
        console.error("TeamTalk Error:", err.message);
    });
}

connectTeamTalk();

setInterval(() => {
    if (connected) {
        send("ping");
    }
}, 30000);

app.get("/", (req, res) => {
    res.json({
        name: "Techno Notify",
        connected,
        uptime: uptime(),
        users: Object.keys(state.users).length,
        channels: Object.keys(state.channels).length
    });
});

app.get("/api/status", (req, res) => {
    res.json({
        connected,
        uptime: uptime(),
        server: CONFIG.host,
        port: CONFIG.port,
        channel: CONFIG.channel,
        users: Object.keys(state.users).length,
        channels: Object.keys(state.channels).length,
        stats: state.stats
    });
});

app.get("/api/users", (req, res) => {
    res.json(Object.values(state.users));
});

app.get("/api/channels", (req, res) => {
    res.json(Object.values(state.channels));
});

app.post("/api/command", (req, res) => {
    const { command } = req.body;

    if (!connected) {
        return res.status(503).json({
            success: false,
            error: "TeamTalk not connected"
        });
    }

    if (!command) {
        return res.status(400).json({
            success: false,
            error: "Missing command"
        });
    }

    send(command);

    res.json({
        success: true,
        command
    });
});

app.post("/api/message", (req, res) => {
    const { userid, content } = req.body;

    if (!connected) {
        return res.status(503).json({
            success: false,
            error: "TeamTalk not connected"
        });
    }

    if (!userid || !content) {
        return res.status(400).json({
            success: false,
            error: "userid and content required"
        });
    }

    send(`message userid=${userid} content="${content}"`);

    res.json({
        success: true
    });
});

wss.on("connection", ws => {
    console.log("WebSocket client connected.");

    ws.send(JSON.stringify({
        type: "status",
        data: {
            connected,
            uptime: uptime(),
            users: Object.keys(state.users).length,
            channels: Object.keys(state.channels).length
        }
    }));

    ws.send(JSON.stringify({
        type: "snapshot",
        data: {
            users: Object.values(state.users),
            channels: Object.values(state.channels)
        }
    }));
});

server.listen(PORT, () => {
    console.log(`Techno Notify running on port ${PORT}`);
});
