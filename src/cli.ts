#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enforcement } from "./bundle.ts";
import {
    ConfigError,
    DEFAULT_OUT,
    resolveTargets,
    type ConfigFile,
    type Target,
} from "./config.ts";
import { diffManifest, inspect, isSnapshot } from "./format.ts";
import { planGeneration, renameCandidates, type SchemaChange } from "./generate.ts";
import {
    emptyJournal,
    parseJournal,
    snapshotManifest,
    snapshotPath,
    journalPath,
    type Journal,
    type SchemaSnapshot,
} from "./journal.ts";
import { readSnapshotHeaderFile } from "./io.ts";
import { Schema } from "./schema.ts";

const tty = process.stdout.isTTY === true;
const paint = (code: string, text: string) => (tty ? `[${code}m${text}[0m` : text);
const bold = (text: string) => paint("1", text);
const dim = (text: string) => paint("2", text);
const red = (text: string) => paint("31", text);
const green = (text: string) => paint("32", text);
const yellow = (text: string) => paint("33", text);

/**
 * Indented while a run is working through one schema of several, so a target's
 * whole block sits under its heading without every call knowing about it.
 */
let indent = "";

const write = (text: string) => process.stdout.write(text.length === 0 ? "\n" : `${indent}${text}\n`);
const warn = (text: string) => process.stderr.write(`${yellow("!")} ${text}\n`);
const fail = (text: string): never => {
    process.stderr.write(`${red("✗")} ${text}\n`);
    process.exit(1);
};

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

const args = process.argv.slice(2);
const command = args[0];

const flag = (name: string): string | undefined => {
    const inline = args.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);

    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
};

const flags = (name: string): string[] =>
    args
        .map((arg, index) =>
            arg === `--${name}` ? args[index + 1] : arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined,
        )
        .filter((value): value is string => value !== undefined);

const REEXEC_FLAG = "BURSZTYN_REEXEC";

const loadConfigFile = async (): Promise<ConfigFile> => {
    const path = resolve(flag("config") ?? "bursztyn.config.json");

    try {
        return JSON.parse(await readFile(path, "utf8")) as ConfigFile;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        if (error instanceof SyntaxError) fail(`${path} is not valid JSON.\n\n  ${error.message}`);
        throw error;
    }
};

/** The schemas this invocation works on, in config order. */
const loadTargets = async (): Promise<Target[]> => {
    const file = await loadConfigFile();

    try {
        return resolveTargets(file, {
            schema: flag("schema"),
            out: flag("out"),
            export: flag("export"),
            only: flags("only"),
        });
    } catch (error) {
        if (error instanceof ConfigError) return fail(error.message);
        throw error;
    }
};

/** What to tell someone to run when this particular schema needs regenerating. */
const fixCommand = (target: Target): string =>
    target.multiSchema ? `bursztyn generate --only ${target.name}` : "bursztyn generate";

/**
 * A folder named after the package shadows it for bare specifiers: the schema's
 * own `from "bursztyn"` can land on the migrations folder, and `bun bursztyn
 * generate` runs the generated bundle instead of this CLI — printing nothing
 * and exiting 0, which reads as the command having done nothing. Any segment of
 * the path does it, so `./bursztyn/stops` is caught too.
 *
 * Emitted before the schema is loaded, because the usual symptom is that the
 * schema fails to load. A process we handed over to stays quiet so the warning
 * is not printed twice.
 */
let shadowWarned = false;

const warnIfOutShadowsPackage = (out: string) => {
    if (shadowWarned || process.env[REEXEC_FLAG] === "1") return;

    const parts = relative(process.cwd(), resolve(out)).split(sep);
    const index = parts.indexOf("bursztyn");
    if (index === -1) return;

    // The offending folder, not the whole path: with several schemas the
    // shadowing one is the shared root they all sit under.
    const joined = parts.slice(0, index + 1).join("/");
    const folder = joined.startsWith(".") ? joined : `./${joined}`;
    shadowWarned = true;

    warn(
        `${bold(folder)} has the same name as the package, so ${bold("bun bursztyn …")} runs the\n` +
            `  generated bundle instead of this CLI, and a schema importing ${bold('"bursztyn"')} can\n` +
            `  resolve to it. Rename ${bold("out")} — ${bold(DEFAULT_OUT)} is the default.\n`,
    );
};

const ensureBundleStub = async (target: Target) => {
    const path = resolve(target.out, "index.ts");
    if (await readFile(path, "utf8").then(() => true).catch(() => false)) return;

    const name = target.multiSchema ? `    name: "${target.name}",\n` : "";

    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        `// Generated by bursztyn — do not edit.\n` +
            `import { defineMigrations } from "${target.importFrom}";\n\n` +
            `export default defineMigrations({\n${name}    hash: "0",\n    entries: [],\n});\n`,
    );
};

/** Bun as PATH holds it — `bun.exe`, or a `bun.cmd` shim if it came from npm. */
const findBun = (): string | null => {
    const extensions =
        process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir.length === 0) continue;
        for (const extension of extensions) {
            const candidate = join(dir, `bun${extension}`);
            if (existsSync(candidate)) return candidate;
        }
    }

    return null;
};

/**
 * Hand the whole invocation to Bun and exit with whatever it returns.
 *
 * This CLI ships with a `#!/usr/bin/env node` shebang, and the bin shims a
 * package manager writes — `bursztyn.cmd` on Windows especially — hardcode
 * `node`. So `bun bursztyn` and `bunx bursztyn` both still start Node, which
 * cannot import a TypeScript schema module. Telling the user to "run it with
 * Bun" was advice they had usually already followed.
 */
const rerunUnderBun = (path: string, cause: unknown): never => {
    const bun = process.env[REEXEC_FLAG] === "1" ? null : findBun();

    if (bun) {
        const argv = [fileURLToPath(import.meta.url), ...args];
        const env = { ...process.env, [REEXEC_FLAG]: "1" };

        // Node refuses to execute .cmd/.bat directly, so an npm-installed Bun
        // has to go through the shell. stdio is inherited either way, so the
        // rename prompt still reaches the terminal and the exit code survives
        // for CI.
        const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
        const result = /\.(cmd|bat)$/i.test(bun)
            ? spawnSync(quote(bun), argv.map(quote), { stdio: "inherit", env, shell: true })
            : spawnSync(bun, argv, { stdio: "inherit", env });

        if (!result.error) process.exit(result.status ?? 0);
    }

    return fail(
        `Could not import ${path}.\n\n` +
            `  Node cannot import TypeScript, and ${bold("bun")} is not on PATH to do it instead.\n\n` +
            `  Install Bun, or point ${bold("schema")} at a module Node can load.\n\n` +
            `  ${dim(String(cause))}`,
    );
};

const schemaExports = async (path: string): Promise<[name: string, schema: Schema<any>][]> => {
    const absolute = isAbsolute(path) ? path : resolve(path);
    const nodeCannotLoadIt = absolute.endsWith(".ts") && !("Bun" in globalThis) && !("Deno" in globalThis);
    let module: Record<string, unknown>;

    try {
        module = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
    } catch (error) {
        // Recent Node strips types on its own, so this is attempted first and
        // only handed over when it actually fails.
        if (nodeCannotLoadIt) return rerunUnderBun(path, error);
        return fail(`Could not import ${path}\n\n  ${String(error)}`);
    }

    return Object.entries(module).filter(
        (entry): entry is [string, Schema<any>] => entry[1] instanceof Schema,
    );
};

/**
 * One target, one schema. A module holding several is not guessed at — picking
 * the wrong one would generate a migration for a schema nobody asked about and
 * leave the other silently untracked.
 */
const loadSchema = async (target: Target): Promise<Schema<any>> => {
    const found = await schemaExports(target.schema);
    const names = found.map(([name]) => name);

    if (target.export !== undefined) {
        const match = found.find(([name]) => name === target.export);
        if (match) return match[1];

        return fail(
            `${target.schema} has no schema exported as ${bold(target.export)}.\n\n` +
                (found.length > 0
                    ? `  It exports: ${names.join(", ")}`
                    : `  It exports no schema at all.`),
        );
    }

    if (found.length === 1) return found[0][1];

    if (found.length === 0) {
        return fail(
            `${target.schema} does not export a schema.\n\n  Expected something built with ${bold("defineSchema()")}.`,
        );
    }

    const entries = names
        .map((name) => `        { "schema": "${target.schema}", "export": "${name}" }`)
        .join(",\n");

    return fail(
        `${target.schema} exports ${found.length} schemas: ${names.join(", ")}.\n\n` +
            `  Each one needs its own migrations folder, so say which is which:\n\n` +
            `    { "schemas": [\n${entries}\n    ] }\n\n` +
            `  …or pass ${bold("--export <name>")}.`,
    );
};

interface Loaded {
    target: Target;
    schema: Schema<any>;
}

/**
 * Stubs first, then every schema, then any work — so a run that has to hand
 * itself to Bun, or that names an export that does not exist, does it before
 * the first target has written anything.
 */
const load = async (targets: Target[]): Promise<Loaded[]> => {
    enforcement.enabled = false;

    for (const target of targets) {
        warnIfOutShadowsPackage(target.out);
        await ensureBundleStub(target);
    }

    const loaded: Loaded[] = [];
    for (const target of targets) loaded.push({ target, schema: await loadSchema(target) });
    return loaded;
};

const readJournal = async (out: string): Promise<Journal> => {
    try {
        return parseJournal(await readFile(resolve(journalPath(out)), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyJournal();
        throw error;
    }
};

const readSnapshot = async (out: string, version: number): Promise<SchemaSnapshot> =>
    JSON.parse(await readFile(resolve(snapshotPath(out, version)), "utf8")) as SchemaSnapshot;

const lastSnapshot = async (out: string, journal: Journal): Promise<SchemaSnapshot | null> => {
    const latest = journal.entries.at(-1);
    return latest ? readSnapshot(out, latest.version) : null;
};

const ask = async (question: string): Promise<boolean> => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await rl.question(`${indent}${question} ${dim("[y/N]")} `);
        return answer.trim().toLowerCase().startsWith("y");
    } finally {
        rl.close();
    }
};

const describeChangeLines = (change: SchemaChange): string[] => {
    const lines: string[] = [];
    for (const field of change.added) lines.push(`  ${green("+")} ${field.name} ${dim(field.signature)}`);
    for (const field of change.removed) lines.push(`  ${red("-")} ${field.name} ${dim(field.signature)}`);
    for (const field of change.changed) {
        lines.push(`  ${yellow("~")} ${field.name} ${dim(`${field.before} → ${field.after}`)}`);
    }
    for (const entry of change.renamed) {
        lines.push(`  ${yellow("→")} ${entry.from} ${dim("renamed to")} ${entry.to}`);
    }
    if (change.reordered) lines.push(`  ${dim("· fields reordered")}`);
    return lines;
};

/** Printed above a target's block, but only when the run covers several. */
const heading = (target: Target, first: boolean) => {
    if (!first) process.stdout.write("\n");
    process.stdout.write(`${bold(target.name)}  ${dim(target.schema)}\n`);
};

const generateOne = async (
    { target, schema }: Loaded,
    given: { name?: string; renames: Record<string, string> },
): Promise<number> => {
    const journal = await readJournal(target.out);
    const previous = await lastSnapshot(target.out, journal);
    const renames = { ...given.renames };

    if (previous) {
        const diff = diffManifest(snapshotManifest(previous), schema.compiled.layout);
        const candidates = renameCandidates(diff).filter(
            (candidate) => renames[candidate.removed] === undefined,
        );

        for (const candidate of candidates) {
            const question =
                `${yellow("?")} Is ${bold(candidate.removed)} renamed to ${bold(candidate.added)}` +
                ` ${dim(`(both ${candidate.signature})`)}?`;

            if (!tty) {
                fail(
                    `Ambiguous change${target.multiSchema ? ` in "${target.name}"` : ""}: ` +
                        `${candidate.removed} disappeared and ${candidate.added} appeared, ` +
                        `both ${candidate.signature}.\n\n` +
                        `  If it is a rename:  ${fixCommand(target)} --rename ${candidate.removed}=${candidate.added}\n` +
                        `  If it is not, run this in a terminal and answer the prompt.`,
                );
            }

            if (await ask(question)) renames[candidate.removed] = candidate.added;
        }
    }

    const result = planGeneration({
        compiled: schema.compiled,
        journal,
        previous,
        out: target.out,
        importFrom: target.importFrom,
        schemaName: target.multiSchema ? target.name : undefined,
        name: given.name,
        renames,
        timestamp: new Date().toISOString(),
    });

    if (result.status === "up-to-date") {
        write(`${green("✓")} Schema is up to date ${dim(`(version ${previous!.version})`)}`);
        return 0;
    }

    for (const file of result.files) {
        await mkdir(dirname(resolve(file.path)), { recursive: true });
        await writeFile(resolve(file.path), file.content);
    }

    if (result.status === "initial") {
        write(`${green("✓")} Initialised ${bold(target.out)} at version 0`);
        write(dim(`  ${schema.compiled.layout.length} fields recorded in meta/0000_snapshot.json`));
        write("");
        write(`  Import the generated bundle in your schema module:`);
        write(dim(`    import migrations from "${target.out}";`));
        write(dim(`    export const schema = defineSchema({ fields, migrations });`));
        return 0;
    }

    write(`${green("✓")} ${bold(result.id!)}`);
    write("");
    for (const line of describeChangeLines(result.change!)) write(line);
    write("");

    const pending = result.change!.added.length + result.change!.changed.length;
    if (pending === 0) {
        write(`  ${green("Nothing to fill in")} — every field is carried over untouched.`);
        return 0;
    }

    write(
        `  ${yellow(`⚠ ${pending} field${pending === 1 ? "" : "s"} need${pending === 1 ? "s" : ""} data.`)}`,
    );
    write(
        `  Open ${bold(result.files[0].path)}, fill in ${bold("up()")}, then delete the names from ${bold("pending")}.`,
    );
    write("");
    write(`  ${dim("Until then the app refuses to start.")}`);
    return pending;
};

const runGenerate = async () => {
    const targets = await loadTargets();
    const many = targets.length > 1;
    const name = flag("name");
    const renamePairs = flags("rename");

    // Both describe one specific change to one specific schema; applying either
    // to a whole project would mislabel whatever else happened to be dirty.
    if (many && (name !== undefined || renamePairs.length > 0)) {
        fail(
            `${bold("--name")} and ${bold("--rename")} apply to one schema, ` +
                `but ${targets.length} are selected.\n\n` +
                `  Add ${bold("--only <name>")} — this project has: ${targets.map((target) => target.name).join(", ")}`,
        );
    }

    const renames: Record<string, string> = {};
    for (const pair of renamePairs) {
        const [from, to] = pair.split("=");
        if (!from || !to) fail(`--rename expects old=new, got "${pair}"`);
        renames[from] = to;
    }

    const loaded = await load(targets);
    let unfinishedFields = 0;
    let unfinishedSchemas = 0;

    for (const [index, entry] of loaded.entries()) {
        if (many) heading(entry.target, index === 0);
        indent = many ? "  " : "";

        const pending = await generateOne(entry, { name, renames });
        if (pending > 0) {
            unfinishedFields += pending;
            unfinishedSchemas++;
        }
    }

    indent = "";

    if (unfinishedSchemas === 0) return;

    process.exitCode = 1;
    if (!many) return;

    write("");
    write(
        yellow(
            `⚠ ${unfinishedFields} field${unfinishedFields === 1 ? "" : "s"} across ` +
                `${unfinishedSchemas} schema${unfinishedSchemas === 1 ? "" : "s"} still need` +
                `${unfinishedFields === 1 ? "s" : ""} data.`,
        ),
    );
};

/** True when this schema is generated, finished, and matches its folder. */
const statusOne = async ({ target, schema }: Loaded): Promise<boolean> => {
    const journal = await readJournal(target.out);
    const previous = await lastSnapshot(target.out, journal);

    if (!previous) {
        write(`${yellow("!")} ${bold(target.out)} is empty — run ${bold(fixCommand(target))}`);
        return false;
    }

    if (BigInt(previous.hash) !== schema.compiled.hash) {
        write(`${red("✗")} Schema has uncommitted changes ${dim(`(version ${previous.version})`)}`);
        write("");
        const diff = diffManifest(snapshotManifest(previous), schema.compiled.layout);
        for (const entry of diff) {
            if (entry.kind === "added") write(`  ${green("+")} ${entry.name} ${dim(entry.signature)}`);
            if (entry.kind === "removed") write(`  ${red("-")} ${entry.name} ${dim(entry.signature)}`);
            if (entry.kind === "changed") {
                write(`  ${yellow("~")} ${entry.name} ${dim(`${entry.before} → ${entry.after}`)}`);
            }
        }
        write("");
        write(`  Run:  ${bold(fixCommand(target))}`);
        return false;
    }

    const bundle = await import(pathToFileURL(resolve(target.out, "index.ts")).href)
        .then((module) => module.default)
        .catch(() => null);

    if (bundle?.unfinished?.length) {
        write(`${red("✗")} Unfinished migrations`);
        write("");
        for (const entry of bundle.unfinished) {
            write(`  ${bold(entry.id)}`);
            for (const field of entry.pending) write(`    ${yellow("-")} ${field}`);
        }
        write("");
        write(`  Fill in ${bold("up()")}, then delete those names from ${bold("pending")}.`);
        return false;
    }

    write(`${green("✓")} Up to date ${dim(`— version ${previous.version}, ${previous.fields.length} fields`)}`);
    return true;
};

const runStatus = async () => {
    const targets = await loadTargets();
    const many = targets.length > 1;
    const loaded = await load(targets);
    let failing = 0;

    for (const [index, entry] of loaded.entries()) {
        if (many) heading(entry.target, index === 0);
        indent = many ? "  " : "";

        if (!(await statusOne(entry))) failing++;
    }

    indent = "";

    if (failing > 0) process.exitCode = 1;
    if (!many) return;

    write("");
    write(
        failing === 0
            ? `${green("✓")} ${loaded.length} schemas up to date`
            : `${red("✗")} ${failing} of ${loaded.length} schemas need attention`,
    );
};

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
};

const runInspect = async () => {
    const file = args[1];
    if (!file) fail("bursztyn inspect <file.brsz>");

    // Sizes all come out of the manifest and the section table, so inspecting a
    // 4 GiB snapshot reads a few kilobytes of it.
    const { bytes, size } = await readSnapshotHeaderFile(file);
    if (!isSnapshot(bytes)) fail(`${file} is not a bursztyn snapshot.`);

    const info = inspect(bytes, size);
    const sort = flag("sort") ?? "bytes";
    const fields = [...info.fields];

    if (sort === "bytes") fields.sort((a, b) => b.bytes - a.bytes);
    if (sort === "name") fields.sort((a, b) => a.name.localeCompare(b.name));

    if (args.includes("--json")) {
        write(JSON.stringify({ ...info, schemaHash: info.schemaHash.toString(), fields }, null, 2));
        return;
    }

    const rows = fields.slice(0, Number(flag("top") ?? fields.length));
    const nameWidth = Math.max(5, ...rows.map((row) => row.name.length));
    const sizeWidth = Math.max(5, ...rows.map((row) => formatBytes(row.bytes).length));

    write(bold(file));
    write(dim(`  format v${info.formatVersion}  schema v${info.schemaVersion}  hash ${info.schemaHash}`));
    write(`  ${formatBytes(info.totalBytes)} across ${info.fields.length} fields\n`);

    for (const row of rows) {
        const share = info.totalBytes > 0 ? (row.bytes / info.totalBytes) * 100 : 0;
        write(
            `  ${row.name.padEnd(nameWidth)}  ${formatBytes(row.bytes).padStart(sizeWidth)}  ` +
                `${share.toFixed(1).padStart(5)}%  ${dim(row.signature)}`,
        );
    }

    if (rows.length < fields.length) write(dim(`\n  … ${fields.length - rows.length} more`));
};

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
