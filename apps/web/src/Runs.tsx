import { useEffect, useState } from "react";
import { RUN_MODE_LABELS, RUN_STATUS_LABELS, type AppKind, type Run, type RunItem, type Task } from "@mngboard/shared";
import { api } from "./api.ts";

const ICON: Record<RunItem["kind"], string> = { message: "▸", command: "$", tool: "⚙", error: "!" };

export function StartAgent({
  task,
  apps,
  onError,
  onStarted,
}: {
  task: Task;
  apps: { app: AppKind; bin: string | null; loggedIn: boolean | null; hint: string }[];
  onError: (m: string | null) => void;
  onStarted: () => void;
}) {
  const usable = apps.filter((a) => a.bin && a.loggedIn !== false);
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState<AppKind>(usable[0]?.app ?? "codex");
  const [mode, setMode] = useState<"read-only" | "worktree-write">("read-only");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return <button onClick={() => { setOpen(true); setPrompt(`${task.title}\n\n${task.body}`.trim()); }}>Agent starten</button>;
  }

  const chosen = apps.find((a) => a.app === app);
  const needsWorktree = mode === "worktree-write" && !task.worktree;

  async function start() {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    try {
    const res = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.id, app, mode, prompt }),
    });
    if (res.ok) {
      setOpen(false);
      onError(null);
      onStarted();
    } else {
      onError(((await res.json()) as { error?: string }).error ?? "Start fehlgeschlagen");
    }
    } catch { onError("Verbindung fehlgeschlagen. Der Start ist nicht bestätigt; vor erneutem Start die Läufe prüfen."); } finally { setBusy(false); }
  }

  return (
    <div className="start-agent">
      <div className="row-inline">
        <select value={app} onChange={(e) => setApp(e.target.value as AppKind)} aria-label="Werkzeug">
          {apps.map((a) => (
            <option key={a.app} value={a.app} disabled={!a.bin || a.loggedIn === false}>
              {a.app}
              {!a.bin ? " (nicht installiert)" : a.loggedIn === false ? " (nicht angemeldet)" : ""}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="Rechte">
          <option value="read-only">{RUN_MODE_LABELS["read-only"]}</option>
          <option value="worktree-write">{RUN_MODE_LABELS["worktree-write"]}</option>
        </select>
        <button onClick={() => void start()} disabled={busy || !prompt.trim() || !chosen?.bin || chosen?.loggedIn === false || needsWorktree}>Starten</button>
        <button onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Auftrag an den Agent" aria-label="Auftrag" />
      {needsWorktree && <p className="warn">Schreibende Läufe brauchen einen Worktree. Lege zuerst einen an.</p>}
      {chosen && (!chosen.bin || chosen.loggedIn === false) && <p className="warn">{chosen.hint}</p>}
      {mode === "worktree-write" && task.worktree && (
        <p className="warn">Der Agent darf Dateien in {task.worktree.path} ändern. Der Branch {task.worktree.branch} hält die Arbeit getrennt.</p>
      )}
    </div>
  );
}

export function RunList({ runs, live }: { runs: Run[]; live: Record<number, RunItem[]> }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [items, setItems] = useState<RunItem[]>([]);

  useEffect(() => {
    if (openId == null) return;
    void api(`/api/runs/${openId}/items`).then((r) => r.json()).then(setItems).catch(() => setItems([]));
  }, [openId]);

  if (!runs.length) return null;
  return (
    <div className="runs">
      {runs.map((r) => {
        const shown = openId === r.id ? [...items, ...(live[r.id] ?? [])] : [];
        return (
          <div key={r.id} className={`run ${r.status}`}>
            <div className="run-head"><button className="run-toggle" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
              <span className="chip">{r.app}</span>
              <span className="chip">{RUN_MODE_LABELS[r.mode]}</span>
              <b>{RUN_STATUS_LABELS[r.status]}</b>
              <span className="muted">#{r.id} · {new Date(r.startedAt).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" })}</span>
              {r.startedBy && <span className="chip" title="Von dieser Session angestoßen">↖ {r.startedBy.label}</span>}
              </button>
              {r.status === "running" && (
                <button onClick={(e) => { e.stopPropagation(); void api(`/api/runs/${r.id}/stop`, { method: "POST" }); }}>Abbrechen</button>
              )}
            </div>
            {r.summary && <pre className="run-summary">{r.summary}</pre>}
            {r.pushLog && <details><summary>Push und Hook-Nachweis</summary><pre className="run-summary">{r.pushLog}</pre></details>}
            {openId === r.id && (
              <div className="run-items">
                {shown.length === 0 && <span className="muted">Noch keine Ausgabe.</span>}
                {shown.map((i, n) => (
                  <div key={n} className={`run-item ${i.kind}`}>
                    <span className="icon">{ICON[i.kind]}</span>
                    <pre>{i.text}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
