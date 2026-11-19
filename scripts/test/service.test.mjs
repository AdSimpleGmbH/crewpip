import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));

for (const [action, managed] of [
  ["install", true],
  ["install", false],
  ["restart", true],
  ["restart", false],
]) {
  test(
    action +
      " nach Node-Upgrade erhält " +
      (managed ? "den verwalteten Suchpfad des Runners" : "einen individuellen PATH"),
    async (t) => {
      const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewpip-node-upgrade-")));
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
  bootout) rm -f "$HOME/loaded"; exit 0 ;;
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
      const next = path.join(sandbox, "Cellar/node/new/bin/node");
      fs.mkdirSync(path.dirname(next), { recursive: true });
      fs.copyFileSync(process.execPath, next, fs.constants.COPYFILE_FICLONE);
      const nextBin = path.dirname(next),
        priorBin = path.dirname(previous);
      const testCli = path.join(nextBin, "claude");
      fs.writeFileSync(testCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const command = path.join(checkout, "scripts/service.mjs");
      const serviceEnv = {
        HOME: sandbox,
        PATH: bin + ":" + process.env.PATH,
        CREWPIP_PORT: env.CREWPIP_PORT,
        CREWPIP_TOKEN: "fixture-only",
      };
      const custom = path.join(sandbox, "company tools");
      const plist = path.join(sandbox, "Library/LaunchAgents/crewpip.plist");
      let searchPath;
      if (managed) {
        fs.mkdirSync(priorBin, { recursive: true });
        fs.copyFileSync(process.execPath, previous, fs.constants.COPYFILE_FICLONE);
        await run(previous, [command, "install"], { env: serviceEnv, timeout: 15000 });
        const initial = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist]));
        assert.equal(initial.ProgramArguments[0], previous);
        searchPath = initial.EnvironmentVariables.PATH.split(":");
        assert.equal(searchPath[0], priorBin);
        searchPath.splice(1, 0, custom);
        // Eine vorhandene Referenz desselben Zielpfads darf keine Dublette erzeugen.
        if (action === "install") searchPath.push(nextBin);
        fs.rmSync(previous);
      } else {
        searchPath = [custom, priorBin, "/usr/bin"];
      }
      env.PATH = searchPath.join(":");
      const installed = {
        Label: "crewpip",
        ProgramArguments: [previous, entry, "extra argument"],
        WorkingDirectory: checkout,
        EnvironmentVariables: env,
        KeepAlive: true,
        RunAtLoad: true,
        ThrottleInterval: 12,
      };
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(
        plist,
        execFileSync("plutil", ["-convert", "binary1", "-o", "-", "--", "-"], {
          input: JSON.stringify(installed),
        }),
        { mode: 0o600 },
      );
      await run(next, [command, action], {
        env: serviceEnv,
        timeout: 15000,
      });
      const actual = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist]));
      assert.equal(actual.ProgramArguments[0], next);
      if (managed) {
        const runner = pathToFileURL(path.join(repo, "apps/daemon/src/runner/apps.ts")).href;
        const found = execFileSync(
          next,
          [
            "--input-type=module",
            "-e",
            `import {claudeApp} from ${JSON.stringify(runner)}; console.log(claudeApp.bin());`,
          ],
          { env: { HOME: sandbox, PATH: actual.EnvironmentVariables.PATH }, encoding: "utf8" },
        ).trim();
        assert.equal(found, testCli);
      }
      const expectedPath = managed
        ? [nextBin, ...searchPath.slice(1).filter((dir) => dir !== nextBin)]
        : searchPath;
      assert.deepEqual(actual, {
        ...installed,
        ProgramArguments: [next, entry, "extra argument"],
        EnvironmentVariables: { ...env, PATH: expectedPath.join(":") },
      });
      assert.equal(fs.statSync(plist).mode & 0o777, 0o600);
    },
  );
}
