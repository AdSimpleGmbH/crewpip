import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { chainFrom, parseLsof, parsePs, systemProbe, type Proc } from "../src/peer.js";

const hasLsof = (() => {
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch (e) {
    // lsof -v endet je nach Version mit 1, gibt es aber.
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
})();

test("parseLsof nimmt den Prozess mit genau dieser Verbindung, nicht den Daemon selbst", () => {
  const out = [
    "p52834", "cnode", "f19", "n127.0.0.1:7357->127.0.0.1:62282",
    "p31486", "cclaude", "f16", "n127.0.0.1:62282->127.0.0.1:7357",
    "p777", "cother", "f3", "n127.0.0.1:62282->127.0.0.1:9999",
  ].join("\n");
  assert.deepEqual(parseLsof(out, "127.0.0.1:62282->127.0.0.1:7357", 52834), { pid: 31486, comm: "claude" });
  assert.equal(parseLsof(out, "127.0.0.1:1->127.0.0.1:7357", 52834), null);
  assert.equal(parseLsof("", "x", 1), null);
});

test("chainFrom: Shells über dem Hook fallen weg, launchd auch, höchstens vier Stufen", () => {
  const table = parsePs(
    [
      "    1     0 /sbin/launchd",
      "42893     1 /Applications/Claude.app/Contents/MacOS/Claude",
      "31485 42893 /Applications/Claude.app/Contents/Helpers/disclaimer",
      "31486 31485 /Users/a/Library/Application Support/Claude/claude-code/2.1.274/claude.app/Contents/MacOS/claude",
      "50000 31486 /bin/sh",
      "50001 50000 /bin/zsh",
      "50002 50001 /opt/homebrew/bin/node",
    ].join("\n"),
  );
  assert.equal(table.get(31486)?.comm, "claude", "Pfad mit Leerzeichen");
  assert.deepEqual(chainFrom(50002, table), [
    { pid: 31486, comm: "claude" },
    { pid: 31485, comm: "disclaimer" },
    { pid: 42893, comm: "Claude" },
  ]);
  assert.deepEqual(chainFrom(424242, table), [], "unbekannter Prozess");
});

test("systemProbe erkennt den echten Prozess am anderen Ende und seine Eltern", { skip: !hasLsof && "lsof fehlt" }, async () => {
  const probe = systemProbe();
  let seen: { owner: Proc | null; chain: Proc[] } | null = null;
  const server = http.createServer(async (req, res) => {
    const s = req.socket;
    const sock = { remoteAddress: s.remoteAddress, remotePort: s.remotePort, localAddress: s.localAddress, localPort: s.localPort };
    seen = { owner: await probe.owner(sock), chain: await probe.agentChain(sock) };
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    // Ein eigener Prozess ruft an, wie ein Hook oder ein Agent es täte.
    const child = execFile(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}/").then((r) => r.text())`]);
    const childPid = child.pid!;
    await new Promise<void>((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))));
    assert.ok(seen, "Anfrage kam an");
    const { owner, chain } = seen as { owner: Proc | null; chain: Proc[] };
    assert.equal(owner?.pid, childPid, "Anrufer ist der Kindprozess, nicht dieser Testprozess");
    assert.equal(chain[0]?.pid, process.pid, "über dem Anrufer steht dieser Testprozess");
  } finally {
    server.close();
  }
});
