import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCheck, CircleHelp, Folder, LayoutDashboard, ListTodo, MessageSquare, Search, Send, Radio, ChevronRight, Plus } from "lucide-react";
import { APP_LABELS, DELIVERY_LABELS, ROLE_LABELS, SESSION_ROLES, TASK_STATUS_LABELS, type AppKind, type Message, type Project, type Run, type RunItem, type Session, type Task, type WsEvent } from "@mngboard/shared";
import { api, wsUrl } from "./api.ts";
import { Tasks } from "./Tasks.tsx";
import { Content } from "./Content.tsx";

const NAME_KEY = "mngboard.humanName";
type View = "overview" | "messages" | "tasks" | "guide";
const date = (iso: string) => new Date(iso).toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
const preview = (text: string) => text.replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim();

function MessageCard({ message: m, onReply, expanded = false }: { message: Message; onReply: (m: Message) => void; expanded?: boolean }) {
  return <article className="message-card">
    <header><span className={`badge app-${m.from.kind === "session" ? m.from.app : "human"}`}>{m.from.kind === "session" ? APP_LABELS[m.from.app] : "Person"}</span>
      <strong>{m.from.kind === "session" ? `${m.from.project} / ${m.from.name}` : m.from.name}</strong><time dateTime={m.createdAt}>{date(m.createdAt)}</time></header>
    <div className="message-target">An {m.toLabel} · #{m.id}</div>
    <details open={expanded || undefined}><summary><span>{preview(m.text).slice(0, 230)}{m.text.length > 230 ? "…" : ""}</span><span className="read-more">Meldung aufklappen</span></summary><Content text={m.text} /></details>
    <footer><span>{m.pending.length ? `${m.pending.length} Chat(s) warten auf Zustellung` : m.deliveries.length ? "Im Empfänger-Chat zugestellt" : "Noch keine Zustellung bestätigt"}</span><button className="text-button" onClick={() => onReply(m)}>Antworten <ArrowRight size={14} /></button></footer>
    {!!(m.deliveries.length || m.pending.length) && <details className="delivery-details"><summary>Zustellnachweise</summary>{m.deliveries.map(d => <p key={d.sessionId}>{d.sessionLabel}: {DELIVERY_LABELS[d.method]} · {date(d.at)}</p>)}{m.pending.map(p => <p key={p}>{p}: wartet</p>)}</details>}
  </article>;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View>("overview");
  const [runs, setRuns] = useState<Run[]>([]);
  const [runApps, setRunApps] = useState<{ app: AppKind; bin: string | null; loggedIn: boolean | null; hint: string }[]>([]);
  const [liveItems, setLiveItems] = useState<Record<number, RunItem[]>>({});
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [search, setSearch] = useState("");
  const [messageScope, setMessageScope] = useState("all");
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [from, setFrom] = useState(() => { try { return localStorage.getItem(NAME_KEY) ?? "Mensch"; } catch { return "Mensch"; } });
  const [to, setTo] = useState("director");
  const [text, setText] = useState("");
  const [compose, setCompose] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sendLock = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const urls = ["/api/messages", "/api/sessions", "/api/tasks?status=open,claimed,review,done,cancelled", "/api/projects", "/api/runs"];
        const [m, s, t, p, r] = await Promise.all(urls.map(async url => { const res = await api(url); if (!res.ok) throw new Error(`Daten konnten nicht geladen werden (${res.status}).`); return res.json(); }));
        if (!closed) { setMessages(m); setSessions(s); setTasks(t); setProjects(p); setRuns(r); setLoaded(true); }
      } catch (e) { if (!closed) setError(`${e instanceof Error ? e.message : "Verbindung fehlgeschlagen"} Bitte die Seite neu laden.`); }
    }
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => { setConnected(true); void refresh(); };
      ws.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(connect, 2000); };
      ws.onmessage = ev => {
        const e = JSON.parse(ev.data) as WsEvent;
        if (e.type === "message") setMessages(m => m.some(x => x.id === e.message.id) ? m : [...m, e.message]);
        if (e.type === "sessions") setSessions(e.sessions);
        if (e.type === "tasks") setTasks(e.tasks);
        if (e.type === "projects") setProjects(e.projects);
        if (e.type === "runs") setRuns(e.runs);
        if (e.type === "run-item") setLiveItems(m => ({ ...m, [e.runId]: [...(m[e.runId] ?? []), e.item] }));
        if (e.type === "delivery") setMessages(m => m.map(x => x.id !== e.messageId || x.deliveries.some(d => d.sessionId === e.delivery.sessionId) ? x : { ...x, deliveries: [...x.deliveries, e.delivery], pending: x.pending.filter(p => p !== e.delivery.sessionLabel) }));
      };
    };
    void refresh(); connect();
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, []);
  // CLI sign-in probes can take seconds. Do not block the overview on them.
  useEffect(() => {
    if (view !== "tasks" || runApps.length) return;
    let closed = false;
    void api("/api/runner/apps").then(async res => { if (!res.ok) throw new Error("Agentenstatus konnte nicht geladen werden."); return res.json(); }).then(apps => { if (!closed) setRunApps(apps); }).catch(() => { if (!closed) setError("Agentenstatus konnte nicht geladen werden. Aufgaben bleiben bedienbar."); });
    return () => { closed = true; };
  }, [view, runApps.length]);
  useEffect(() => { try { localStorage.setItem(NAME_KEY, from); } catch { /* Storage is optional. */ } }, [from]);
  useEffect(() => { scroll.current?.scrollTo(0, 0); }, [view, projectId]);
  useEffect(() => { if (compose) input.current?.focus(); }, [compose, to]);

  const selected = projects.find(p => p.id === projectId);
  const projectSessions = sessions.filter(s => !projectId || s.projectId === projectId);
  const openTasks = tasks.filter(t => (!projectId || t.projectId === projectId) && !["done", "cancelled"].includes(t.status));
  const review = openTasks.filter(t => t.status === "review");
  const activeRuns = runs.filter(r => r.status === "running" && (!projectId || r.projectId === projectId));
  const directors = sessions.filter(s => s.role === "director" && s.status !== "ended");
  const relevant = useMemo(() => messages.filter(m => !selected ||
    (m.from.kind === "session" && m.from.project === selected.name) ||
    (m.to.kind === "project" && m.to.name === selected.name) || (m.to.kind === "pm" && m.to.project === selected.name) ||
    (m.to.kind === "session" && sessions.some(s => m.to.kind === "session" && s.id === m.to.id && s.projectId === selected.id))
  ).sort((a, b) => b.id - a.id), [messages, selected, sessions]);
  const shown = relevant.filter(m => (!search || `${m.from.label} ${m.toLabel} ${m.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) &&
    (messageScope === "all" || (messageScope === "director" && m.to.kind === "director") || (messageScope === "waiting" && (m.pending.length > 0 || m.deliveries.length === 0))));
  const latest = relevant.filter(m => m.from.kind === "session" && m.to.kind === "director").filter((m, i, arr) => arr.findIndex(x => x.from.kind === "session" && m.from.kind === "session" && x.from.project === m.from.project) === i).slice(0, 6);
  const visibleProjects = projects.filter(p => projectSearch ? p.name.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase()) : showAllProjects || p.id === projectId || tasks.some(t => t.projectId === p.id && !["done", "cancelled"].includes(t.status)) || sessions.some(s => s.projectId === p.id && s.status !== "ended") || messages.some(m => m.from.kind === "session" && m.from.project === p.name && Date.now() - Date.parse(m.createdAt) < 7 * 86400000)).sort((a, b) => a.name.localeCompare(b.name));

  const roleWaiting = to === "director" ? !directors.length : to.startsWith("pm:") && !sessions.some(s => s.role === "pm" && s.project === to.slice(3) && s.status !== "ended");
  function write(target = selected ? `pm:${selected.name}` : "director") { setTo(target); setCompose(true); setNotice(""); }
  function reply(m: Message) { write(m.replyTo); }
  async function send() {
    if (sendLock.current || !text.trim()) return;
    sendLock.current = true; setSending(true); setError(null);
    try {
      const res = await api("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: from.trim() || "Mensch", to, text: text.trim() }) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Senden fehlgeschlagen");
      setText(""); setCompose(false); setNotice("Nachricht gespeichert. Sie wird beim nächsten Kontakt des Empfänger-Chats zugestellt.");
    } catch (e) { setError(e instanceof Error ? e.message : "Senden fehlgeschlagen. Dein Text bleibt erhalten."); }
    finally { setSending(false); sendLock.current = false; }
  }
  async function editSession(s: Session, data: object) {
    try {
      const res = await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Änderung fehlgeschlagen");
    } catch (e) { setError(String(e)); }
  }
  async function forget(s: Session) {
    if (!confirm(`${s.label} aus dem Board austragen? Der Chat selbst bleibt erhalten.`)) return;
    try { const res = await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }); if (!res.ok) throw new Error("Austragen fehlgeschlagen"); } catch (e) { setError(String(e)); }
  }

  return <div className="layout">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView("overview"); setProjectId(null); }}><span className="brand-mark"><LayoutDashboard size={19} /></span>CrewPip<span className="brand-dot">.</span></a>
      <div className="workspace-label">DEIN PROJEKT-COCKPIT</div>
      <nav className="primary-nav" aria-label="Hauptnavigation">
        {([["overview", "Überblick", LayoutDashboard], ["tasks", "Aufgaben", ListTodo], ["messages", "Nachrichten", MessageSquare]] as const).map(([id, label, Icon]) => <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon size={18} />{label}{id === "tasks" && <span className="nav-count">{openTasks.length}</span>}</button>)}
      </nav>
      <div className="section">PROJEKTE <span>{visibleProjects.length}</span></div>
      <label className="search-field sidebar-search"><Search size={15} /><input aria-label="Projekte suchen" placeholder="Projekt suchen …" value={projectSearch} onChange={e => setProjectSearch(e.target.value)} /></label>
      <div className="project-list"><button className={`project-link ${!projectId ? "selected" : ""}`} onClick={() => setProjectId(null)}><LayoutDashboard size={15} /><span>Alle Projekte</span></button>
        {visibleProjects.map(p => <button key={p.id} title={p.name} className={`project-link ${projectId === p.id ? "selected" : ""}`} onClick={() => setProjectId(p.id)}><Folder size={15} /><span>{p.name}</span>{p.openTasks > 0 && <span className="nav-count">{p.openTasks}</span>}</button>)}
        {!visibleProjects.length && loaded && <p className="hint">Kein passendes Projekt.</p>}
      </div>
      <button className="text-button all-projects" onClick={() => setShowAllProjects(v => !v)}>{showAllProjects ? "Nur mit Chats, Aufgaben oder neuen Meldungen" : `Alle ${projects.length} Projekte anzeigen`}</button>
      <div className="sidebar-bottom"><button className="text-button" onClick={() => setView("guide")}><CircleHelp size={17} />Was kann ich hier tun?</button><span className={`connection ${connected ? "online" : ""}`}><i />{connected ? "Lokal verbunden" : "Verbindung wird hergestellt …"}</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="breadcrumb">Arbeitsbereich</span><ChevronRight size={14} /><strong className="desktop-project">{selected?.name ?? "Alle Projekte"}</strong><select className="mobile-project" aria-label="Projekt auswählen" value={projectId ?? ""} onChange={e => setProjectId(e.target.value || null)}><option value="">Alle Projekte</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div><button className="secondary" onClick={() => write()}><MessageSquare size={16} />{selected ? "PM schreiben" : "Director schreiben"}</button></header>
      {error && <div role="alert" className="error-banner">{error}<button onClick={() => setError(null)} aria-label="Fehlermeldung schließen">×</button></div>}
      {notice && <div role="status" className="notice-banner">{notice}</div>}
      {!connected && loaded && <div role="status" className="error-banner">Verbindung unterbrochen. Die angezeigten Daten sind der zuletzt geladene Stand.</div>}
      <div className="workspace" ref={scroll}>
        {!loaded ? <div className="empty">Board wird geladen …</div> : <>
        {view === "overview" && <>
          <div className="page-heading"><div><p className="eyebrow">ÜBERBLICK · {new Date().toLocaleDateString("de-AT", { day: "numeric", month: "long" })}</p><h1>Was steht an?</h1><p>Hier siehst du offene Arbeit und die letzten Meldungen deiner Projekte.</p></div><button className="primary" onClick={() => setView("tasks")}><Plus size={17} />Aufgabe planen</button></div>
          <div className="stats-grid">
            <button className="stat" onClick={() => setView("tasks")}><span><ListTodo size={18} />Offene Arbeit</span><strong>{openTasks.length}</strong><small>Aufgaben ansehen <ArrowRight size={15} /></small></button>
            <button className="stat attention" onClick={() => setView("tasks")}><span><CheckCheck size={18} />Bereit zur Prüfung</span><strong>{review.length}</strong><small>Ergebnisse prüfen <ArrowRight size={15} /></small></button>
            <div className="stat"><span><Radio size={18} />Gestartete Agenten</span><strong>{activeRuns.length}</strong><small>{activeRuns.length ? "Laufen über dieses Board" : "Derzeit läuft kein Board-Agent"}</small></div>
          </div>
          <section className="orientation"><div className="orientation-icon"><Send size={22} /></div><div><h2>Du gibst die Richtung vor.</h2><p>Schreib dem Director, was du erreichen möchtest. Er koordiniert die Projektmanager. Unter Aufgaben kannst du Arbeit festhalten und Ergebnisse prüfen.</p><span>Eine Nachricht startet keinen Chat automatisch. Zustellung erfolgt beim nächsten Kontakt.</span></div><button className="secondary" onClick={() => setView("guide")}>So funktioniert’s <ArrowRight size={15} /></button></section>
          {!directors.length && <div className="error-banner">Kein Director-Chat angemeldet. Nachrichten an den Director warten, bis ein Chat diese Rolle übernimmt.</div>}
          <div className="overview-columns"><section><div className="section-heading"><h2>Als Nächstes</h2><button className="text-button" onClick={() => setView("tasks")}>Alle Aufgaben <ArrowRight size={15} /></button></div>
            <div className="next-list">{[...review, ...openTasks.filter(t => t.status !== "review")].slice(0, 4).map(t => <button key={t.id} className="next-task" onClick={() => { setProjectId(t.projectId); setView("tasks"); }}><span className={`status-tag ${t.status}`}>{TASK_STATUS_LABELS[t.status]}</span><strong>{t.title}</strong><span>{t.projectName} · #{t.id}</span><ArrowRight size={17} /></button>)}{!openTasks.length && <div className="empty"><CheckCheck size={26} /><p>Keine offenen Board-Aufgaben.</p><small>Du kannst eine neue Aufgabe planen oder dem Director schreiben.</small></div>}</div>
          </section><section className="coordination"><div className="section-heading"><h2>Deine Steuerzentrale</h2></div><div className="coordination-body"><div className="role-step"><b>Du</b><span>Ziel nennen · Ergebnis prüfen</span></div><div className="flow-line">↓</div><div className="role-step"><b>Director</b><span>{directors.length ? `${directors.length} Chat angemeldet` : "Kein Chat angemeldet"}</span></div><div className="flow-line">↓</div><div className="role-step"><b>Projektmanager → Worker</b><span>Planen · umsetzen · zurückmelden</span></div><p>Die Anzeige erfasst Board-Läufe. Andere Chats und Automationen können unabhängig arbeiten.</p></div></section></div>
          <div className="section-heading reports-heading"><div><h2>Letzte Projektmeldungen</h2><p>Je Projekt die neueste Meldung an den Director. Das Datum zeigt, wie aktuell sie ist.</p></div><button className="text-button" onClick={() => { setView("messages"); setMessageScope("director"); }}>Alle lesen <ArrowRight size={15} /></button></div>
          <div className="report-grid">{latest.map(m => <MessageCard key={m.id} message={m} onReply={reply} />)}{!latest.length && <p className="hint">Noch keine Projektmeldung an den Director vorhanden.</p>}</div>
        </>}
        {view === "tasks" && <><div className="page-heading"><div><p className="eyebrow">PLANEN & PRÜFEN</p><h1>Aufgaben</h1><p>Festhalten, zuweisen und Ergebnisse abnehmen. Das Anlegen startet noch keinen Agenten.</p></div></div><Tasks tasks={tasks} projects={projects} sessions={sessions} projectFilter={projectId} onError={setError} runs={runs} runApps={runApps} liveItems={liveItems} /></>}
        {view === "messages" && <><div className="page-heading"><div><p className="eyebrow">PROJEKTVERLAUF</p><h1>Nachrichten</h1><p>Meldungen der Chats, neueste zuerst. Aufklappen, lesen oder gezielt antworten.</p></div><button className="primary" onClick={() => write()}><Plus size={17} />Nachricht schreiben</button></div><div className="message-filters"><label className="search-field"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} aria-label="Nachrichten durchsuchen" placeholder="Nachricht oder Projekt suchen …" /></label><select aria-label="Nachrichten filtern" value={messageScope} onChange={e => setMessageScope(e.target.value)}><option value="all">Alle Nachrichten</option><option value="director">An den Director</option><option value="waiting">Zustellung ausstehend</option></select><span>{shown.length} Meldungen</span></div><div className="message-list">{shown.slice(0, 100).map(m => <MessageCard key={m.id} message={m} onReply={reply} />)}{shown.length > 100 && <p>Die neuesten 100 Treffer werden angezeigt. Grenze die Suche ein, um ältere Meldungen zu finden.</p>}{!shown.length && <div className="empty">Keine Nachrichten für diese Auswahl.</div>}</div></>}
        {view === "guide" && <><div className="page-heading"><div><p className="eyebrow">KURZ ERKLÄRT</p><h1>So nutzt du dein Board.</h1><p>Ein Ort für den Überblick, konkrete Aufträge und die Rückmeldungen deiner Chats.</p></div></div><div className="guide-grid">
          <article><span className="step-number">1</span><h2>Ein Ziel nennen</h2><p>Zum Beispiel: „Prüfe den Stand von CrewPip und nenne mir den nächsten Schritt.“ Der Director ist dein Ansprechpartner über alle Projekte.</p><button className="primary" onClick={() => write("director")}>Director schreiben <ArrowRight size={16} /></button></article>
          <article><span className="step-number">2</span><h2>Arbeit festhalten</h2><p>Wähle ein Projekt, beschreibe das gewünschte Ergebnis und lege eine Aufgabe an. Eine Zuweisung dokumentiert die Zuständigkeit. Sie startet keinen Chat.</p><button className="secondary" onClick={() => setView("tasks")}>Aufgabe planen <ArrowRight size={16} /></button></article>
          <article><span className="step-number">3</span><h2>Ergebnisse prüfen</h2><p>„Zu prüfen“ heißt: Das Ergebnis liegt zur Abnahme bereit. Lies den Nachweis. Passt es, setze die Aufgabe auf „erledigt“. Sonst gib sie zurück in Arbeit.</p><button className="secondary" onClick={() => setView("tasks")}>Aufgaben ansehen <ArrowRight size={16} /></button></article>
        </div><section className="help-panel"><h2>Was passiert im Hintergrund?</h2><p>Das Board hält Nachrichten, Aufgaben und Laufprotokolle lokal auf diesem Mac. Das Öffnen und Lesen des Boards startet keinen KI-Lauf. Erst „Agent starten“ führt einen neuen Auftrag aus und kann Tokens verbrauchen.</p><p>Nachrichten erreichen einen Chat beim nächsten Hook oder beim Abruf seines Postfachs. „Zugestellt“ bestätigt den Empfang, nicht die Erledigung. Aktive Chats und Automationen außerhalb dieses Boards sind hier nicht vollständig erfasst.</p><p>Technische Arbeit mit Worktrees und Agenten findest du in den Details einer Aufgabe. Ein Worktree hält Änderungen getrennt vom Hauptprojekt.</p></section></>}
        {selected && <details className="session-settings"><summary>Angemeldete Chats in {selected.name} verwalten ({projectSessions.length})</summary><p>Rollen steuern die Zustellung. „Angemeldet“ bedeutet nicht, dass ein Chat gerade rechnet.</p>{projectSessions.map(s => <div className="session-setting" key={s.id}><div><strong>{s.name}</strong><small>{APP_LABELS[s.app]} · zuletzt gemeldet {date(s.lastSeenAt)}</small></div><select aria-label={`Rolle für ${s.name}`} value={s.role ?? ""} onChange={e => void editSession(s, { role: e.target.value || null })}><option value="">Keine Rolle</option>{SESSION_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select><button className="secondary" onClick={() => { const name = prompt("Name des Chats", s.name); if (name?.trim()) void editSession(s, { name: name.trim() }); }}>Umbenennen</button><button className="text-button" onClick={() => void forget(s)}>Austragen</button></div>)}</details>}
        </>}
      </div>
      {compose && <section className="composer" aria-label="Nachricht schreiben"><form onSubmit={e => { e.preventDefault(); void send(); }}><div className="composer-heading"><h2>Nachricht schreiben</h2><button className="text-button" type="button" onClick={() => setCompose(false)}>Schließen · Entwurf behalten</button></div><div className="composer-fields"><label>Von<input value={from} onChange={e => setFrom(e.target.value)} /></label><label>An<select value={to} onChange={e => setTo(e.target.value)}><option value="director">Director · alle Projekte koordinieren</option>{!(["director", "all"].includes(to) || projects.some(p => to === `pm:${p.name}`) || sessions.some(s => to === `session:${s.id}`)) && <option value={to}>{to}</option>}<optgroup label="Projektmanager">{projects.map(p => <option key={p.id} value={`pm:${p.name}`}>PM {p.name}</option>)}</optgroup><optgroup label="Einzelner Chat">{sessions.map(s => <option key={s.id} value={`session:${s.id}`}>{s.label}</option>)}</optgroup><option value="all">Rundnachricht an alle angemeldeten Chats</option></select></label></div><textarea ref={input} aria-label="Nachricht" rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="Was soll erreicht werden? Nenne Projekt, Ziel und wichtige Grenzen." onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} /><div className="composer-footer"><small>{roleWaiting ? "Für diese Rolle ist kein Chat angemeldet. Die Nachricht wartet, bis die Rolle besetzt ist." : to === "all" ? "Rundnachricht: erreicht alle angemeldeten Chats." : "Zustellung beim nächsten Kontakt. Startet den Empfänger-Chat nicht automatisch."}</small><button className="primary" disabled={sending || !text.trim()} type="submit"><Send size={16} />{sending ? "Wird gespeichert …" : "Nachricht senden"}</button></div></form></section>}
    </main>
  </div>;
}
