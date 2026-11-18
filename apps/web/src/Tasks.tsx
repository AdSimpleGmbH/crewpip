import { useEffect, useState } from "react";
import { TASK_STATUS_LABELS, type AppKind, type Project, type Run, type RunItem, type Session, type Task, type TaskStatus } from "@mngboard/shared";
import { api } from "./api.ts";
import { RunList, StartAgent } from "./Runs.tsx";
import { Content } from "./Content.tsx";

const FLOW: Record<TaskStatus, TaskStatus[]> = {
  open: ["claimed", "cancelled"],
  claimed: ["review", "open"],
  review: ["done", "claimed"],
  done: ["open"],
  cancelled: ["open"],
};

const GROUPS: TaskStatus[] = ["review", "claimed", "open", "done", "cancelled"];

/** Befehl, der nach dem Anlegen eines Worktrees darin läuft, etwa `pnpm install --frozen-lockfile`. */
function BootstrapField({ project, onError }: { project: Project; onError: (m: string | null) => void }) {
  const [value, setValue] = useState(project.bootstrap ?? "");
  const [saved, setSaved] = useState(true);
  useEffect(() => { setValue(project.bootstrap ?? ""); setSaved(true); }, [project.id, project.bootstrap]);
  async function save() {
    const err = await call(`/api/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body: JSON.stringify({ bootstrap: value }) });
    onError(err);
    setSaved(!err);
  }
  return (
    <div className="bootstrap-field">
      <label htmlFor="bootstrap">Bootstrap für neue Worktrees in {project.name}</label>
      <input
        id="bootstrap"
        value={value}
        placeholder="leer = keiner; z. B. pnpm install --frozen-lockfile"
        onChange={(e) => { setValue(e.target.value); setSaved(false); }}

      />
      <button className="secondary" disabled={saved} onClick={() => void save()}>{saved ? "Gespeichert" : "Bootstrap speichern"}</button>
    </div>
  );
}

/** Gibt null bei Erfolg zurück, sonst die Fehlermeldung des Daemons. */
async function call(url: string, init?: RequestInit): Promise<string | null> {
  try {
  const res = await api(url, init);
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Fehlgeschlagen (${res.status})`;
  } catch { return "Verbindung fehlgeschlagen. Bitte erneut versuchen."; }
}

export function Tasks({
  tasks,
  projects,
  sessions,
  projectFilter,
  onError,
  runs,
  runApps,
  liveItems,
}: {
  tasks: Task[];
  projects: Project[];
  sessions: Session[];
  projectFilter: string | null;
  onError: (m: string | null) => void;
  runs: Run[];
  runApps: { app: AppKind; bin: string | null; loggedIn: boolean | null; hint: string }[];
  liveItems: Record<number, RunItem[]>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);

  const [chosenProject, setChosenProject] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState("");
  const target = projectFilter ?? chosenProject;
  const targetProject = projects.find(p => p.id === target);
  const shown = tasks.filter((t) => (projectFilter ? t.projectId === projectFilter : true));

  async function run(id: number, fn: () => Promise<string | null>) {
    setBusy(id);
    onError(await fn());
    setBusy(null);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    if (!title.trim()) return onError("Erst einen Titel eingeben");
    if (!targetProject) return onError("Bitte zuerst ein Projekt auswählen.");
    setCreating(true); setCreated("");
    const err = await call("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: target, title, body }),
    });
    setCreating(false);
    onError(err);
    if (!err) {
      setCreated(`Aufgabe in ${targetProject.name} angelegt. Es wurde kein Agent gestartet.`);
      setTitle("");
      setBody("");
    }
  }

  const patch = (id: number, data: Record<string, unknown>) =>
    call(`/api/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

  return (
    <div className="tasks">
      <form className="new-task" onSubmit={create}>
        <label>Projekt<select aria-label="Projekt für neue Aufgabe" value={target} disabled={!!projectFilter} onChange={e => setChosenProject(e.target.value)}><option value="">Projekt auswählen …</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Was soll erreicht werden?<input value={title} onChange={e => setTitle(e.target.value)} placeholder="Zum Beispiel: Startseite verständlicher machen" aria-label="Titel" required /></label>
        <label className="wide">Beschreibung<textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Gewünschtes Ergebnis, wichtige Grenzen und woran du erkennst, dass es fertig ist." rows={2} aria-label="Beschreibung" /></label>
        <p className="form-note">Die Aufgabe wird offen gespeichert. Zuweisen und Agenten starten sind separate Schritte.</p>
        <button type="submit" disabled={creating || !targetProject || !title.trim()}>{creating ? "Wird angelegt …" : "Aufgabe anlegen"}</button>
        {created && <p className="form-note" role="status">{created}</p>}
      </form>
      {targetProject && <details className="session-settings"><summary>Technische Projekteinstellungen</summary><BootstrapField project={targetProject} onError={onError} /></details>}

      {GROUPS.filter((g) => showDone || (g !== "done" && g !== "cancelled")).map((group) => {
        const list = shown.filter((t) => t.status === group);
        if (!list.length) return null;
        return (
          <section key={group}>
            <h2>{TASK_STATUS_LABELS[group]} <span className="count-plain">{list.length}</span></h2>
            {list.map((t) => (
              <article key={t.id} className={`task ${t.status}`}>
                <header>
                  <span className="id">#{t.id}</span>
                  <b>{t.title}</b>
                  {!projectFilter && <span className="chip">{t.projectName}</span>}
                </header>
                {t.body && <details><summary>Auftrag und Nachweise lesen</summary><Content text={t.body} /></details>}
                {t.bootstrapLog && (
                  <details className="bootstrap">
                    <summary className={t.bootstrapLog.startsWith("FEHLGESCHLAGEN") ? "warn" : ""}>
                      Bootstrap {t.bootstrapLog.startsWith("FEHLGESCHLAGEN") ? "fehlgeschlagen" : "erfolgreich"}
                    </summary>
                    <pre>{t.bootstrapLog}</pre>
                  </details>
                )}
                <div className="meta">
                  {t.assignee ? <span>{t.assignee.label}</span> : <span className="muted">niemandem zugewiesen</span>}
                  {t.worktree && <span className="chip" title={t.worktree.path}>⌥ {t.worktree.branch}</span>}
                  <span className="muted">von {t.createdBy}</span>
                </div>
                <div className="actions">
                  <select
                    value=""
                    disabled={busy === t.id}
                    onChange={(e) => e.target.value && void run(t.id, () => patch(t.id, { assignee: e.target.value }))}
                    aria-label="Zuständigen Chat zuweisen"
                  >
                    <option value="">zuweisen an …</option>
                    {sessions.filter((s) => s.projectId === t.projectId).map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  {FLOW[t.status].map((next) => (
                    <button key={next} disabled={busy === t.id} onClick={() => void run(t.id, () => patch(t.id, { status: next }))}>
                      → {TASK_STATUS_LABELS[next]}
                    </button>
                  ))}
                </div>
                <details className="task-tech"><summary>Technik: Worktree und Agenten</summary><p className="form-note">Ein Agentenlauf führt einen neuen KI-Auftrag aus und kann Tokens verbrauchen.</p><div className="actions">
                  {t.worktree ? (
                    <button
                      disabled={busy === t.id}
                      title={t.worktree.path}
                      onClick={() =>
                        void run(t.id, async () => {
                          const err = await call(`/api/tasks/${t.id}/worktree`, { method: "DELETE" });
                          if (err && confirm(`${err}\n\nTrotzdem entfernen? Nicht gesicherte Arbeit geht verloren.`)) {
                            return call(`/api/tasks/${t.id}/worktree?force=1`, { method: "DELETE" });
                          }
                          return err;
                        })
                      }
                    >
                      Worktree entfernen
                    </button>
                  ) : (
                    <button disabled={busy === t.id} onClick={() => void run(t.id, () => call(`/api/tasks/${t.id}/worktree`, { method: "POST", body: "{}" }))}>
                      Worktree anlegen
                    </button>
                  )}
                  {t.worktree && (
                    <button onClick={() => void navigator.clipboard?.writeText(t.worktree!.path)} title="Pfad in die Zwischenablage">
                      Pfad kopieren
                    </button>
                  )}
                  {t.status !== "done" && t.status !== "cancelled" && (
                    <StartAgent task={t} apps={runApps} onError={onError} onStarted={() => undefined} />
                  )}
                </div>
                <RunList runs={runs.filter((r) => r.taskId === t.id)} live={liveItems} />
                </details>
              </article>
            ))}
          </section>
        );
      })}

      {!shown.some(t => showDone || !["done", "cancelled"].includes(t.status)) && <div className="empty">Keine Aufgaben in dieser Auswahl.</div>}
      <label className="show-done">
        <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> erledigte und verworfene zeigen
      </label>
    </div>
  );
}
