import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([^#=\s]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const PORT = Number(process.env.PORT || 3001);
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://gate:gate@localhost:5433/gate";
const AI_BASE_URL = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(
  /\/$/,
  ""
);
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
let embedded;

async function ping() {
  await pool.query("select 1");
}

async function startEmbedded() {
  const databaseDir = path.join(process.cwd(), "data", "pg");
  embedded = new EmbeddedPostgres({
    databaseDir,
    user: "gate",
    password: "gate",
    port: 5433,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  if (!existsSync(databaseDir)) await embedded.initialise();
  await embedded.start();
  try {
    await embedded.createDatabase("gate");
  } catch {
    /* already exists */
  }
}

async function waitDb() {
  try {
    await ping();
    return;
  } catch {
    console.log("postgres down → starting embedded cluster on :5433");
  }
  await startEmbedded();
  for (let i = 0; i < 40; i++) {
    try {
      await ping();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error("postgres is not ready on " + DATABASE_URL);
}

async function shutdown() {
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  try {
    await embedded?.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function sid(req, res) {
  const raw = req.headers.cookie || "";
  const found = raw.match(/(?:^|;\s*)sid=([0-9a-f-]{36})/i);
  if (found) return found[1];
  const id = crypto.randomUUID();
  res.append(
    "Set-Cookie",
    `sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
  );
  return id;
}

async function streamOpenAI(history, onDelta) {
  const r = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      stream: true,
      messages: history.map(({ role, content }) => ({ role, content })),
    }),
  });
  if (!r.ok) throw new Error(`AI ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content || "";
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* keep-alive / malformed chunk */
      }
    }
  }
  return full;
}

async function mockStream(text, onDelta) {
  const out = [
    "Гейт в mock-режиме (нет AI_API_KEY).",
    `Запрос: ${text}`,
    "Поставь в .env любой OpenAI-совместимый endpoint: AI_BASE_URL, AI_API_KEY, AI_MODEL.",
    "Примеры: OpenAI, Groq, OpenRouter, Ollama (/v1), Together.",
  ].join("\n");
  for (const ch of out) {
    onDelta(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  return out;
}

await waitDb();
await pool.query(`
  create table if not exists messages (
    id serial primary key,
    session_id uuid not null,
    role text not null,
    content text not null,
    created_at timestamptz default now()
  );
  create index if not exists messages_session_idx on messages (session_id, id);
`);

const app = express();
app.use(express.json({ limit: "32kb" }));

app.get("/api/session", (req, res) => {
  res.json({ sessionId: sid(req, res), mock: !AI_API_KEY, model: AI_MODEL });
});

app.get("/api/history", async (req, res) => {
  const sessionId = sid(req, res);
  const { rows } = await pool.query(
    "select role, content, created_at from messages where session_id = $1 order by id asc",
    [sessionId]
  );
  res.json(rows);
});

app.post("/api/chat", async (req, res) => {
  const sessionId = sid(req, res);
  const message = String(req.body?.message || "").trim().slice(0, 8000);
  if (!message) return res.status(400).json({ error: "empty" });

  await pool.query(
    "insert into messages (session_id, role, content) values ($1, 'user', $2)",
    [sessionId, message]
  );
  const { rows } = await pool.query(
    "select role, content from messages where session_id = $1 order by id asc",
    [sessionId]
  );

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    const full = AI_API_KEY
      ? await streamOpenAI(rows, (delta) => send({ delta }))
      : await mockStream(message, (delta) => send({ delta }));
    await pool.query(
      "insert into messages (session_id, role, content) values ($1, 'assistant', $2)",
      [sessionId, full]
    );
    send({ done: true });
  } catch (err) {
    send({ error: String(err.message || err) });
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`api  http://localhost:${PORT}`);
  console.log(`ai   ${AI_API_KEY ? AI_BASE_URL + " / " + AI_MODEL : "mock (no AI_API_KEY)"}`);
});
