import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Wer ruft an? Der Daemon fragt das Betriebssystem, welcher Prozess das andere Ende einer
 * Loopback-Verbindung hält. Das ist die Grundlage dafür, dass die MCP-Identität an der
 * Sitzung hängt und nicht am Arbeitsverzeichnis (Aufgabe #13): Zwei Chats im selben Ordner
 * sind verschiedene Prozesse.
 *
 * Gemessen am 18.09.2026 auf macOS: lsof für einen Port dauert 0,05 s. Fehlt lsof oder
 * scheitert die Abfrage, liefert alles null bzw. leer, und der Aufrufer fällt auf das
 * Verzeichnis zurück.
 */
export interface Proc {
  pid: number;
  /** Name des Programms ohne Pfad, z. B. "claude" oder "codex" */
  comm: string;
}

export interface SocketEnds {
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
}

export interface ProcessProbe {
  /** Prozess, der die Verbindung auf der Gegenseite hält. */
  owner(sock: SocketEnds): Promise<Proc | null>;
  /**
   * Die Prozesse über dem Hook, der gerade anruft: erst der Agent, dann dessen Eltern.
   * Shells dazwischen fallen weg, weil sie mit dem Hook enden.
   */
  agentChain(sock: SocketEnds): Promise<Proc[]>;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "env"]);
/** Tiefer als bis zur App (Claude.app, ChatGPT.app) muss niemand suchen. */
const CHAIN_DEPTH = 4;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // lsof endet mit 1, wenn es nichts findet; die Ausgabe ist dann leer.
      resolve(err && !stdout ? "" : String(stdout));
    });
  });
}

const bare = (addr?: string) => (addr ?? "").replace(/^::ffff:/, "");

/** Liest `lsof -F pcn`: Zeilen p<pid>, c<name>, n<adresse>. */
export function parseLsof(out: string, wanted: string, self: number): Proc | null {
  let pid = 0;
  let comm = "";
  for (const line of out.split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      pid = Number(val);
      comm = "";
    } else if (tag === "c") comm = val;
    else if (tag === "n" && val === wanted && pid && pid !== self) return { pid, comm: path.basename(comm) };
  }
  return null;
}

/** Liest `ps -A -o pid=,ppid=,comm=`. Der Programmpfad darf Leerzeichen enthalten. */
export function parsePs(out: string): Map<number, { ppid: number; comm: string }> {
  const table = new Map<number, { ppid: number; comm: string }>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: path.basename(m[3]!) });
  }
  return table;
}

/** Vorfahren ab dem Elternprozess, Shells am Anfang übersprungen, ohne launchd. */
export function chainFrom(pid: number, table: Map<number, { ppid: number; comm: string }>): Proc[] {
  const out: Proc[] = [];
  let cur = table.get(pid)?.ppid ?? 0;
  const seen = new Set<number>();
  while (cur > 1 && !seen.has(cur) && out.length < CHAIN_DEPTH) {
    seen.add(cur);
    const p = table.get(cur);
    if (!p) break;
    if (!(out.length === 0 && SHELLS.has(p.comm))) out.push({ pid: cur, comm: p.comm });
    cur = p.ppid;
  }
  return out;
}

export function systemProbe(): ProcessProbe {
  const owner = async (sock: SocketEnds): Promise<Proc | null> => {
    if (!sock.remotePort || !sock.localPort) return null;
    const from = `${bare(sock.remoteAddress)}:${sock.remotePort}`;
    const to = `${bare(sock.localAddress)}:${sock.localPort}`;
    const out = await run("lsof", ["-nP", "+c", "0", "-Fpcn", `-iTCP@${bare(sock.remoteAddress)}:${sock.remotePort}`]);
    // Aus Sicht des Anrufers heißt die Verbindung "<sein Port>-><unser Port>".
    return parseLsof(out, `${from}->${to}`, process.pid);
  };
  return {
    owner,
    async agentChain(sock) {
      const [hook, ps] = await Promise.all([owner(sock), run("ps", ["-A", "-o", "pid=,ppid=,comm="])]);
      return hook ? chainFrom(hook.pid, parsePs(ps)) : [];
    },
  };
}

/** Für Tests und Umgebungen ohne lsof: erkennt nie etwas, alles läuft über das Verzeichnis. */
export const nullProbe: ProcessProbe = {
  owner: async () => null,
  agentChain: async () => [],
};
