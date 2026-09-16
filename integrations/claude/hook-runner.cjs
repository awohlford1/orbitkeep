"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const packageEntry = require.resolve("orbitkeep", { paths: [process.cwd(), __dirname] });
  const cliEntry = path.join(path.dirname(packageEntry), "cli", "index.js");
  // Import while argv still identifies this runner so the CLI's normal
  // executable-entry check does not invoke it a second time.
  const cli = await import(pathToFileURL(cliEntry).href);
  process.argv = [process.execPath, cliEntry, "provider", "claude", "hook", "--json"];
  await cli.runCli();
}

main().catch((error) => {
  process.stderr.write(`Orbitkeep Claude hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
