import { useEffect, useRef, useState } from "react";

const lsKey = (sid) => `gate-history:${sid}`;

export default function App() {
  const [meta, setMeta] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const s = await fetch("/api/session").then((r) => r.json());
      const db = await fetch("/api/history").then((r) => r.json());
      const local = JSON.parse(localStorage.getItem(lsKey(s.sessionId)) || "[]");
      if (!live) return;
      setMeta(s);
      setMsgs(db.length ? db : local);
    })().catch((e) => setErr(String(e.message || e)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (meta?.sessionId) localStorage.setItem(lsKey(meta.sessionId), JSON.stringify(msgs));
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs, meta]);

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setErr("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) throw new Error("chat failed");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() || "";
        for (const chunk of chunks) {
          const line = chunk.replace(/^data:\s*/, "").trim();
          if (!line) continue;
          let json;
          try {
            json = JSON.parse(line);
          } catch {
            continue;
          }
          if (json.error) setErr(json.error);
          if (json.delta) {
            setMsgs((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              next[next.length - 1] = { ...last, content: last.content + json.delta };
              return next;
            });
          }
        }
      }
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <header>
        <strong>Гейт</strong>
        <span className="meta">
          {meta?.mock ? "mock" : meta?.model}
          {meta?.sessionId ? ` · ${meta.sessionId.slice(0, 8)}` : ""}
        </span>
      </header>

      <main>
        {msgs.length === 0 && (
          <p className="hint">Анонимная сессия уже открыта. Напиши запрос.</p>
        )}
        {msgs.map((m, i) => (
          <article key={i} className={m.role}>
            <b>{m.role === "user" ? "ты" : "гейт"}</b>
            <pre>{m.content || (busy && i === msgs.length - 1 ? "…" : "")}</pre>
          </article>
        ))}
        {err && <p className="err">{err}</p>}
        <div ref={end} />
      </main>

      <form onSubmit={send}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          placeholder="запрос"
          rows={2}
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "…" : "отправить"}
        </button>
      </form>
    </div>
  );
}
