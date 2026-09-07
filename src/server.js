"use strict";

const http = require("node:http");
const net = require("node:net");

// touched by the first preview test
const SERVICE = process.env.SERVICE_NAME || "service-a";
const ROLE = process.env.SERVICE_ROLE || "web";
const IMAGE_TAG = process.env.IMAGE_TAG || "dev";
const GIT_SHA = (process.env.GIT_SHA || "unknown").slice(0, 7);
const GIT_REF = process.env.GIT_REF || "unknown";
const STACK_ID = process.env.STACK_ID || "local";
const PORT = Number(process.env.PORT || 3000);

// Peers are injected per stack so a preview never reaches another stack's services.
const PEERS = (process.env.PEERS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [name, url] = entry.split("=");
    return { name, url };
  });

const REDIS_HOST = process.env.REDIS_HOST || "";
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const PG_HOST = process.env.PG_HOST || "";
const PG_PORT = Number(process.env.PG_PORT || 5432);
const PG_DATABASE = process.env.PG_DATABASE || "";

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!host) return resolve({ ok: false, error: "not configured" });
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done({ ok: true }));
    socket.on("timeout", () => done({ ok: false, error: "timeout" }));
    socket.on("error", (err) => done({ ok: false, error: err.code || err.message }));
  });
}

// Minimal RESP client: enough to prove each stack owns an isolated Redis dataset.
function redisCommand(args, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    if (!REDIS_HOST) return reject(new Error("redis not configured"));
    const socket = net.connect({ host: REDIS_HOST, port: REDIS_PORT });
    let buffer = "";
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => fail(new Error("redis timeout")));
    socket.on("error", fail);
    socket.on("connect", () => {
      const payload =
        `*${args.length}\r\n` +
        args.map((arg) => `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`).join("");
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.endsWith("\r\n")) return;
      socket.destroy();
      const marker = buffer[0];
      const body = buffer.slice(1, buffer.indexOf("\r\n"));
      if (marker === "-") return reject(new Error(body));
      resolve(marker === ":" || marker === "+" ? body : buffer);
    });
  });
}

async function collectInfo() {
  const [redis, postgres] = await Promise.all([
    tcpProbe(REDIS_HOST, REDIS_PORT),
    tcpProbe(PG_HOST, PG_PORT),
  ]);

  let visits = null;
  if (redis.ok) {
    visits = await redisCommand(["INCR", `visits:${SERVICE}`]).catch(() => null);
  }

  return {
    service: SERVICE,
    role: ROLE,
    stack: STACK_ID,
    image_tag: IMAGE_TAG,
    git_sha: GIT_SHA,
    git_ref: GIT_REF,
    hostname: require("node:os").hostname(),
    dependencies: {
      redis: { ...redis, database: `db0 @ ${REDIS_HOST}` },
      postgres: { ...postgres, database: PG_DATABASE },
    },
    visits: visits === null ? null : Number(visits),
  };
}

async function fetchPeers() {
  return Promise.all(
    PEERS.map(async (peer) => {
      try {
        const res = await fetch(`${peer.url}/api/info`, {
          signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { name: peer.name, ok: true, info: await res.json() };
      } catch (err) {
        return { name: peer.name, ok: false, error: err.message };
      }
    })
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char];
  });
}

function renderPeerCard(peer) {
  if (!peer.ok) {
    return `<article class="card down">
      <h2>${escapeHtml(peer.name)}</h2>
      <p class="err">unreachable: ${escapeHtml(peer.error)}</p>
    </article>`;
  }
  const info = peer.info;
  const isPr = String(info.image_tag).startsWith("pr-");
  return `<article class="card">
    <h2>${escapeHtml(info.service)}</h2>
    <p><span class="tag ${isPr ? "pr" : "main"}">${escapeHtml(info.image_tag)}</span></p>
    <dl>
      <dt>git ref</dt><dd>${escapeHtml(info.git_ref)}</dd>
      <dt>sha</dt><dd><code>${escapeHtml(info.git_sha)}</code></dd>
      <dt>postgres</dt><dd>${info.dependencies.postgres.ok ? "up" : "down"} · ${escapeHtml(info.dependencies.postgres.database)}</dd>
      <dt>redis visits</dt><dd>${escapeHtml(info.visits ?? "n/a")}</dd>
    </dl>
  </article>`;
}

function renderPage(self, peers) {
  const isPr = String(self.image_tag).startsWith("pr-");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(self.stack)} · preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 40px; background: #0d1117; color: #e6edf3;
         font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .stack { color: #7d8590; margin-bottom: 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card { border: 1px solid #30363d; border-radius: 6px; padding: 16px; background: #161b22; }
  .card.self { border-color: #1f6feb; }
  .card.down { border-color: #f85149; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 10px 0 0; }
  dt { color: #7d8590; }
  dd { margin: 0; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .tag.pr { background: #1f6feb; color: #fff; }
  .tag.main { background: #30363d; color: #adbac7; }
  .err { color: #f85149; }
</style>
</head>
<body>
  <h1>Preview environment</h1>
  <p class="stack">stack <strong>${escapeHtml(self.stack)}</strong> · every service below runs in this stack's own network, database and volumes</p>
  <div class="grid">
    <article class="card self">
      <h2>${escapeHtml(self.service)} <small>(this service)</small></h2>
      <p><span class="tag ${isPr ? "pr" : "main"}">${escapeHtml(self.image_tag)}</span></p>
      <dl>
        <dt>git ref</dt><dd>${escapeHtml(self.git_ref)}</dd>
        <dt>sha</dt><dd><code>${escapeHtml(self.git_sha)}</code></dd>
        <dt>container</dt><dd>${escapeHtml(self.hostname)}</dd>
        <dt>postgres</dt><dd>${self.dependencies.postgres.ok ? "up" : "down"} · ${escapeHtml(self.dependencies.postgres.database)}</dd>
        <dt>redis visits</dt><dd>${escapeHtml(self.visits ?? "n/a")}</dd>
      </dl>
    </article>
    ${peers.map(renderPeerCard).join("\n")}
  </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", service: SERVICE }));
  }

  if (url.pathname === "/readyz") {
    const [redis, postgres] = await Promise.all([
      tcpProbe(REDIS_HOST, REDIS_PORT),
      tcpProbe(PG_HOST, PG_PORT),
    ]);
    const ready = redis.ok && postgres.ok;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ready, redis, postgres }));
  }

  if (url.pathname === "/api/info") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(await collectInfo(), null, 2));
  }

  if (url.pathname === "/" && ROLE === "web") {
    const [self, peers] = await Promise.all([collectInfo(), fetchPeers()]);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(renderPage(self, peers));
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(await collectInfo(), null, 2));
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`${SERVICE} (${IMAGE_TAG}) listening on :${PORT} in stack ${STACK_ID}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
