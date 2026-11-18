import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS, type Migration } from "./migrations.js";

export interface AppliedMigration {
  id: string;
  appliedAt: string;
}

export interface MigrationReport {
  applied: string[];
  /** Pfad der Sicherung, die vor dem Umzug angelegt wurde. */
  backup: string | null;
}

function quote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

function ensureLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
}

export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  ensureLedger(db);
  return (db.prepare("SELECT id, applied_at AS appliedAt FROM schema_migrations ORDER BY id").all() as unknown as AppliedMigration[]) ?? [];
}

export function pendingMigrations(db: DatabaseSync): Migration[] {
  const done = new Set(appliedMigrations(db).map((m) => m.id));
  return MIGRATIONS.filter((m) => !done.has(m.id));
}

/**
 * Legt vor dem ersten Umzug eine Kopie der Datenbank an. `VACUUM INTO` schreibt einen
 * in sich stimmigen Stand, auch bei eingeschaltetem WAL; ein bloßes Kopieren der Datei täte
 * das nicht. Die letzten `keep` Sicherungen bleiben liegen.
 */
export function backupDb(db: DatabaseSync, dbPath: string, keep = 10): string | null {
  if (dbPath === ":memory:") return null;
  const dir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(dir, `${path.basename(dbPath, path.extname(dbPath))}-${stamp}`);
  // Zwei Sicherungen in derselben Millisekunde dürfen sich nicht überschreiben.
  let target = `${base}.db`;
  for (let n = 2; fs.existsSync(target); n++) target = `${base}-${n}.db`;
  db.exec(`VACUUM INTO ${quote(target)}`);
  const old = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .sort()
    .slice(0, -keep);
  for (const f of old) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      // Aufräumen ist Kür.
    }
  }
  return target;
}

/**
 * Wendet offene Umzüge an. Jeder läuft in einer eigenen Transaktion und wird erst danach
 * eingetragen; bricht einer ab, bleibt die Datenbank auf dem Stand davor und der Fehler
 * wird weitergereicht, statt mit halbfertigem Schema weiterzuarbeiten.
 */
export function migrate(db: DatabaseSync, dbPath: string, opts: { log?: (l: string) => void } = {}): MigrationReport {
  const pending = pendingMigrations(db);
  if (!pending.length) return { applied: [], backup: null };

  let backup: string | null = null;
  try {
    backup = backupDb(db, dbPath);
    if (backup) opts.log?.(`[db] Sicherung vor dem Umzug: ${backup}`);
  } catch (e) {
    // Ohne Sicherung wird nicht umgezogen: das Risiko wäre nicht abschätzbar.
    throw new Error(`Sicherung fehlgeschlagen, Umzug abgebrochen: ${(e as Error).message}`);
  }

  const applied: string[] = [];
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations(id) VALUES (?)").run(m.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Umzug ${m.id} fehlgeschlagen: ${(e as Error).message}. Stand unverändert, Sicherung: ${backup ?? "keine"}`);
    }
    applied.push(m.id);
    opts.log?.(`[db] ${m.id} angewandt: ${m.title}`);
  }
  return { applied, backup };
}

export function openDb(dbPath: string, opts: { log?: (l: string) => void } = {}): DatabaseSync {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  // Fremdschlüssel erst nach dem Umzug: Umzüge, die Tabellen neu aufbauen, brauchen sie aus,
  // und die Einstellung wirkt innerhalb einer Transaktion ohnehin nicht.
  db.exec("PRAGMA foreign_keys = OFF");
  migrate(db, dbPath, opts);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Kennung des aktuellen Schemas für die Statusausgabe. */
export function schemaVersion(db: DatabaseSync): string {
  const rows = appliedMigrations(db);
  return rows.length ? rows[rows.length - 1]!.id : "leer";
}
