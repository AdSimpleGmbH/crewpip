#!/usr/bin/env node
/**
 * Zustand der Datenbank ansehen und Umzüge anwenden, ohne den Daemon zu starten.
 *
 *   pnpm db:status    zeigt angewandte und offene Umzüge
 *   pnpm db:migrate   wendet offene an (legt vorher eine Sicherung an)
 *   pnpm db:backup    legt nur eine Sicherung an
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { config } from "./config.js";
import { appliedMigrations, backupDb, migrate, pendingMigrations } from "./db.js";

const cmd = process.argv[2] ?? "status";
const dbPath = config.dbPath;

if (!fs.existsSync(dbPath) && cmd !== "migrate") {
  console.log(`Keine Datenbank unter ${dbPath}. Sie entsteht beim ersten Start des Daemons.`);
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

switch (cmd) {
  case "status": {
    const done = appliedMigrations(db);
    const open = pendingMigrations(db);
    console.log(`Datenbank: ${dbPath}`);
    console.log(`\nAngewandt (${done.length}):`);
    for (const m of done) console.log(`  ${m.id}  ${m.appliedAt}`);
    console.log(`\nOffen (${open.length}):`);
    for (const m of open) console.log(`  ${m.id}  ${m.title}`);
    process.exit(open.length ? 1 : 0);
    break;
  }
  case "migrate": {
    const report = migrate(db, dbPath, { log: (l) => console.log(l) });
    console.log(report.applied.length ? `${report.applied.length} Umzug/Umzüge angewandt.` : "Nichts zu tun.");
    break;
  }
  case "backup": {
    console.log(`Sicherung: ${backupDb(db, dbPath)}`);
    break;
  }
  default:
    console.log("Verwendung: status | migrate | backup");
    process.exit(1);
}
