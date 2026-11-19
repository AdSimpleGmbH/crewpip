// Umzug ausschließlich der zugehörigen MCP- und Hook-Einträge. Andere Einstellungen,
// insbesondere Zugriffsrechte, bleiben erhalten. TOML-Tabellen außerhalb des Servers
// bleiben sogar bytegleich, einschließlich Kommentaren.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { parse } from "smol-toml";
import { parseTree, findNodeAtLocation, modify, applyEdits } from "jsonc-parser";

function renameKey(object, before, after, transform = (value) => value) {
  if (!Object.hasOwn(object, before)) return false;
  const next = transform(object[before]);
  if (Object.hasOwn(object, after) && !equal(object[after], next)) {
    throw new Error("Unterschiedliche Einstellungen für denselben CrewPip-Eintrag");
  }
  object[after] = next;
  delete object[before];
  return true;
}

function migrateServer(server, old) {
  if (!server || typeof server !== "object" || !server.url)
    throw new Error("Unerwartete lokale MCP-Konfiguration");
  const url = new URL(server.url);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    !/^\/mcp\/(claude|codex|cursor)$/.test(url.pathname)
  )
    throw new Error("MCP-Ziel ist kein lokaler CrewPip-Endpunkt");
  const next = server;
  for (const key of ["headers", "http_headers", "env_http_headers"]) {
    if (next[key]) renameKey(next[key], "x-" + old + "-token", "x-crewpip-token");
  }
  return next;
}

function hookCommand(command, old, repo) {
  const previous = old + "-hook.mjs";
  if (!command.includes(previous)) return command;
  // Nur die von den Snippets erzeugte Befehlsform zulassen, auch bei einem
  // absolut angegebenen Node-Interpreter oder in Anführungszeichen gesetzten Pfaden.
  const match =
    /^(\s*(?:'[^']+'|"[^"]+"|\S+)\s+)(?:'([^']+)'|"([^"]+)"|(\S+))(\s+(?:claude|codex|cursor)\s+(?:session-start|prompt|stop|session-end)\s*)$/.exec(
      command,
    );
  const file = match && (match[2] ?? match[3] ?? match[4]);
  if (!file || !file.endsWith("/apps/hook/" + previous))
    throw new Error("Angepassten Hook vor dem Umzug einzeln prüfen");
  const target = path.join(repo, "apps/hook/crewpip-hook.mjs");
  const quoted = /^[/\w.-]+$/.test(target) ? target : "'" + target.replaceAll("'", "'\\''") + "'";
  return match[1] + quoted + match[5];
}

function migrateHooks(hooks, old, repo) {
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const result = [];
    for (const group of groups) {
      const updated = structuredClone(group);
      for (const hook of updated.hooks ?? [updated]) {
        if (typeof hook.command === "string") hook.command = hookCommand(hook.command, old, repo);
      }
      if (Array.isArray(updated.hooks)) {
        updated.hooks = updated.hooks.filter((hook, i, all) => {
          if (!hook.command?.includes("/apps/hook/crewpip-hook.mjs")) return true;
          return !all.slice(0, i).some((other) => equal(other, hook));
        });
      }
      // Ein bereits vorhandener, identischer neuer Hook läuft genau einmal.
      if (
        !equal(group, updated) &&
        (groups.some((g) => equal(g, updated)) || result.some((g) => equal(g, updated)))
      )
        continue;
      result.push(updated);
    }
    hooks[event] = result;
  }
}

// Eine Änderung wird an den Quellpositionen der betroffenen Schlüssel und Werte
// angewandt. So bleibt auch ein großer, parallel gepflegter Chat-Katalog unverändert.
function jsonEdits(source, before, after, keys) {
  let result = source;
  function replace(node, value) {
    result = result.slice(0, node.offset) + JSON.stringify(value) + result.slice(node.offset + node.length);
  }
  function visit(previous, next, parts) {
    if (equal(previous, next)) return;
    const locate = (p) => findNodeAtLocation(parseTree(result), p);
    if (Array.isArray(previous) && Array.isArray(next) && previous.length === next.length) {
      previous.forEach((v, i) => visit(v, next[i], [...parts, i]));
    } else if (
      previous &&
      next &&
      typeof previous === "object" &&
      typeof next === "object" &&
      !Array.isArray(previous) &&
      !Array.isArray(next)
    ) {
      for (const [key, value] of Object.entries(previous)) {
        if (Object.hasOwn(next, key)) {
          visit(value, next[key], [...parts, key]);
          continue;
        }
        const renamed = keys.get(key);
        if (renamed && Object.hasOwn(next, renamed) && !Object.hasOwn(previous, renamed)) {
          replace(locate([...parts, key]).parent.children[0], renamed);
          visit(value, next[renamed], [...parts, renamed]);
        } else {
          result = applyEdits(result, modify(result, [...parts, key], undefined, {}));
        }
      }
      for (const [key, value] of Object.entries(next)) {
        if (!Object.hasOwn(previous, key) && !locate([...parts, key]))
          result = applyEdits(result, modify(result, [...parts, key], value, {}));
      }
    } else {
      replace(locate(parts), next);
    }
  }
  visit(before, after, []);
  if (!equal(JSON.parse(result), after)) throw new Error("JSON-Abgleich fehlgeschlagen");
  return result;
}

function jsonConfig(source, old, repo) {
  const doc = JSON.parse(source);
  const before = structuredClone(doc);
  if (doc.mcpServers) renameKey(doc.mcpServers, old, "crewpip", (s) => migrateServer(s, old));
  if (doc.hooks) migrateHooks(doc.hooks, old, repo);
  if (doc.permissions) {
    const previousPrefix = "mcp__" + old;
    const currentPrefix = "mcp__crewpip";
    const sets = { old: [], current: [] };
    const matches = (rule, prefix) =>
      typeof rule === "string" &&
      (rule === prefix || rule.startsWith(prefix + "__") || rule.startsWith(prefix + "("));
    for (const policy of ["allow", "ask", "deny"]) {
      const rules = doc.permissions[policy];
      if (!Array.isArray(rules)) continue;
      const next = [];
      for (const rule of rules) {
        const previous = matches(rule, previousPrefix);
        const current = matches(rule, currentPrefix);
        const renamed = previous ? currentPrefix + rule.slice(previousPrefix.length) : rule;
        if (previous || current) {
          sets[previous ? "old" : "current"].push(policy + " " + renamed);
          if (!next.includes(renamed)) next.push(renamed);
        } else next.push(rule);
      }
      doc.permissions[policy] = next;
    }
    if (
      sets.old.length &&
      sets.current.length &&
      !equal([...new Set(sets.old)].sort(), [...new Set(sets.current)].sort())
    ) {
      throw new Error("Regeln beider Server haben unterschiedliche Geltungsbereiche");
    }
    if (JSON.stringify(doc.permissions).includes(previousPrefix))
      throw new Error("Angepasste Werkzeugregel einzeln prüfen");
  }
  return jsonEdits(
    source,
    before,
    doc,
    new Map([
      [old, "crewpip"],
      ["x-" + old + "-token", "x-crewpip-token"],
    ]),
  );
}

function tomlConfig(source, old) {
  const doc = parse(source);
  function checkOverrides(doc) {
    if (JSON.stringify(doc).includes("mcp__" + old + "__"))
      throw new Error("Angepasste Codex-Werkzeugkennung vor dem Umzug prüfen");
  }
  if (!doc.mcp_servers?.[old]) {
    checkOverrides(doc);
    return source;
  }
  const duplicate = Object.hasOwn(doc.mcp_servers, "crewpip");
  renameKey(doc.mcp_servers, old, "crewpip", (s) => migrateServer(s, old));
  checkOverrides(doc);
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let inside = false;
  const result = lines
    .map((line) => {
      if (/^\s*\[/.test(line)) {
        const header =
          /^\s*\[\s*(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\.\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*(?:\.|\])/.exec(
            line,
          );
        inside = !!header && (header[1] ?? header[2] ?? header[3]) === old;
        if (inside && !duplicate) return line.replace(old, "crewpip");
      }
      if (!inside) return line;
      if (duplicate) return line.trimStart().startsWith("#") ? line : "";
      if (/^\s*["']?(?:http_headers|env_http_headers)["']?\s*=\s*\{/.test(line)) {
        const field = new RegExp("([,{]\\s*)([\"']?)x-" + old + "-token\\2(?=\\s*=)", "g");
        return line.replace(field, "$1$2x-crewpip-token$2");
      }
      return line.replace(/^(\s*["']?)([\w-]+)(["']?\s*=)/, (whole, start, key, end) =>
        key === "x-" + old + "-token" ? start + "x-crewpip-token" + end : whole,
      );
    })
    .join("");
  // Nur anwenden, wenn die vollständige TOML-Datenstruktur dem geplanten Ergebnis entspricht.
  if (!equal(parse(result), doc)) throw new Error("Angepassten Codex-MCP-Abschnitt vor dem Umzug einzeln prüfen");
  return result;
}

export function configChanges(home, repo, old) {
  const files = [".claude.json", ".claude/settings.json", ".codex/config.toml", ".codex/hooks.json"].map((f) =>
    path.join(home, f),
  );
  const changes = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    if (!before.includes(old)) continue;
    try {
      const after = file.endsWith(".toml") ? tomlConfig(before, old) : jsonConfig(before, old, repo);
      if (before !== after) {
        if (!fs.lstatSync(file).isFile()) throw new Error("Verknüpfte Konfiguration bitte am Ziel überprüfen");
        changes.push({ file, before, after, mode: fs.statSync(file).mode & 0o777 });
      }
    } catch {
      // Parserfehler können ganze Zeilen mitsamt Zugangsdaten enthalten.
      throw new Error("Konfiguration nicht sicher übernehmbar: " + file);
    }
  }
  return changes;
}

// Nur die Token-Header der beteiligten lokalen MCP-Einträge vergleichen. Bei einer
// Installation mit ausschließlich gespeicherter Clientkonfiguration kann so derselbe
// Zugang beim ersten Dienststart weiterverwendet werden.
export function installationToken(changes, dir, expected) {
  const tokens = new Set();
  if (expected) tokens.add(expected);
  const tokenFile = path.join(dir, "token");
  if (fs.existsSync(tokenFile)) tokens.add(fs.readFileSync(tokenFile, "utf8").trim());
  for (const { file, after } of changes) {
    const server = file.endsWith(".toml")
      ? parse(after).mcp_servers?.crewpip
      : JSON.parse(after).mcpServers?.crewpip;
    const token = server?.http_headers?.["x-crewpip-token"] ?? server?.headers?.["x-crewpip-token"];
    if (token) tokens.add(token);
  }
  if (tokens.size > 1)
    throw new Error("Lokale Token stimmen nicht überein. Getrennte Installationen vor dem Umzug prüfen.");
  return [...tokens][0];
}

// Bei einer Rücknahme nur die tatsächlich migrierten Felder zurücklegen. Der
// Claude-Client kann z.B. in derselben Datei gleichzeitig Nutzungszähler pflegen.
export function restoreConfig(file, before, after, current, old) {
  if (current === after) return before;
  if (current === before) return current;
  const isToml = file.endsWith(".toml");
  const decode = isToml ? parse : JSON.parse;
  function undo(original, applied, live) {
    if (equal(original, applied) || equal(original, live)) return live;
    if (equal(applied, live)) return original;
    if ([original, applied, live].every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      const result = { ...live };
      for (const key of new Set([...Object.keys(original), ...Object.keys(applied)])) {
        const value = undo(original[key], applied[key], live[key]);
        if (value === undefined) delete result[key];
        else result[key] = value;
      }
      return result;
    }
    throw new Error("Betroffener Konfigurationseintrag wurde zusätzlich geändert: " + file);
  }
  if (isToml) {
    // Wird das TOML parallel geändert, alle Fassungen für die manuelle
    // Zusammenführung bewahren. Es gibt in Codex keinen Schreib-Lock für Clients.
    throw new Error("Parallele TOML-Änderung vor der Wiederherstellung abgleichen: " + file);
  }
  const doc = decode(current);
  const restored = undo(decode(before), decode(after), doc);
  return jsonEdits(
    current,
    doc,
    restored,
    new Map([
      ["crewpip", old],
      ["x-crewpip-token", "x-" + old + "-token"],
    ]),
  );
}
