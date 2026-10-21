#!/usr/bin/env node
import { DEFAULT_OUT } from "./config.ts";
import { runGenerate } from "./cli/generate.ts";
import { runInspect } from "./cli/inspect.ts";
import { runStatus } from "./cli/status.ts";
import { bold, command, fail, write } from "./cli/terminal.ts";

const USAGE = `${bold("bursztyn")} — schema snapshots with generated migrations

  bursztyn generate [--only <name>] [--name <name>] [--rename <old>=<new>]
  bursztyn status [--only <name>]
  bursztyn inspect <file.brsz> [--json] [--sort=bytes|name|order] [--top=N]

Options:
  --only <name>     act on one schema, by name (repeatable; default: all of them)
  --config <path>   config file (default: ./bursztyn.config.json)
  --schema <path>   a schema module, used instead of the configured list
  --export <name>   which export to take, when a module holds several schemas
  --out <dir>       migrations folder (default: ${DEFAULT_OUT})
`;

switch (command) {
    case "generate":
        await runGenerate();
        break;
    case "status":
    case "check":
        await runStatus();
        break;
    case "inspect":
        await runInspect();
        break;
    case undefined:
    case "help":
    case "--help":
        write(USAGE);
        break;
    default:
        process.stderr.write(`${USAGE}\n`);
        fail(`Unknown command "${command}"`);
}
