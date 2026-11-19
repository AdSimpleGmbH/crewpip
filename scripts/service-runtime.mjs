import path from "node:path";

const daemonScript = "apps/daemon/dist/index.js";

export const daemonEntry = (repo) => path.join(repo, daemonScript);

// Alle drei Startwege verwenden den aufrufenden Checkout und Interpreter.
// Einen individuellen PATH übernehmen wir einschließlich seiner Reihenfolge.
export function serviceRuntime(repo, configuration) {
  const nextBin = path.dirname(process.execPath);
  let searchPath;
  let extraArgs = [];
  if (configuration) {
    const args = configuration.ProgramArguments;
    if (
      configuration.Program ||
      !Array.isArray(args) ||
      args.length < 2 ||
      !args.every((arg) => typeof arg === "string") ||
      !path.isAbsolute(args[0]) ||
      !args[1].endsWith("/" + daemonScript)
    ) {
      throw new Error("Dienst verwendet eine angepasste Startkonfiguration; vor dem Start prüfen");
    }
    extraArgs = args.slice(2);
    searchPath = configuration.EnvironmentVariables?.PATH;
    const previousBin = path.dirname(args[0]);
    const directories = searchPath?.split(path.delimiter);
    if (previousBin !== nextBin && directories?.[0] === previousBin) {
      searchPath = [nextBin, ...directories.slice(1).filter((dir) => dir !== nextBin)].join(path.delimiter);
    }
  } else {
    const defaults = [nextBin, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    searchPath = [...new Set(defaults)].join(path.delimiter);
  }
  return { args: [process.execPath, daemonEntry(repo), ...extraArgs], workingDirectory: repo, searchPath };
}
