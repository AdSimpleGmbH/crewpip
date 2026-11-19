import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));

for (const action of ["install", "restart"]) {
  test(
    action + " aktualisiert den Node-Pfad einer bestehenden Plist und erhält deren Einstellungen",
    async (t) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-node-upgrade-"));
      t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
      const checkout = path.join(sandbox, "checkout");
      fs.mkdirSync(checkout);
      fs.cpSync(path.join(repo, "scripts"), path.join(checkout, "scripts"), { recursive: true });
      fs.symlinkSync(path.join(repo, "node_modules"), path.join(checkout, "node_modules"));
      const entry = path.join(checkout, "apps/daemon/dist/index.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, "");
      const bin = path.join(sandbox, "bin");
      fs.mkdirSync(bin);
      const marker = path.join(sandbox, "loaded");
      fs.writeFileSync(
        path.join(bin, "launchctl"),
        `#!/bin/sh
case "$1" in
  print) echo 'Could not find service' >&2; exit 113 ;;
  bootout) exit 0 ;;
  bootstrap) touch "$HOME/loaded"; exit 0 ;;
esac
exit 1
`,
        { mode: 0o700 },
      );
      const server = http.createServer((req, res) => {
        const ok = fs.existsSync(marker) && req.headers["x-crewpip-token"] === "fixture-only";
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
      });
      t.after(() => server.close());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const env = {
        CREWPIP_PORT: String(server.address().port),
        CREWPIP_TOKEN: "fixture-only",
        APP_SETTING: "retain",
      };
      const previous = path.join(sandbox, "Cellar/node/old/bin/node");
      const installed = {
        Label: "crewpip",
        ProgramArguments: [previous, entry, "extra argument"],
        WorkingDirectory: checkout,
        EnvironmentVariables: env,
        KeepAlive: true,
        RunAtLoad: true,
        ThrottleInterval: 12,
      };
      const plist = path.join(sandbox, "Library/LaunchAgents/crewpip.plist");
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(
        plist,
        execFileSync("plutil", ["-convert", "binary1", "-o", "-", "--", "-"], {
          input: JSON.stringify(installed),
        }),
        { mode: 0o600 },
      );
      await run(process.execPath, [path.join(checkout, "scripts/service.mjs"), action], {
        env: { HOME: sandbox, PATH: bin + ":" + process.env.PATH },
        timeout: 15000,
      });
      const actual = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist]));
      assert.equal(actual.ProgramArguments[0], process.execPath);
      assert.deepEqual(actual, { ...installed, ProgramArguments: [process.execPath, entry, "extra argument"] });
      assert.equal(fs.statSync(plist).mode & 0o777, 0o600);
    },
  );
}
