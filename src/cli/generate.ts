import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { diffManifest } from "../format.ts";
import { planGeneration, renameCandidates, type SchemaChange } from "../generate.ts";
import { snapshotManifest } from "../journal.ts";
import { fixCommand, lastSnapshot, load, loadTargets, readJournal, type Loaded } from "./load.ts";
import {
    bold,
    dim,
    fail,
    flag,
    flags,
    green,
    heading,
    indented,
    red,
    setIndent,
    tty,
    write,
    yellow,
} from "./terminal.ts";

const ask = async (question: string): Promise<boolean> => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await rl.question(indented(`${question} ${dim("[y/N]")} `));
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

export const runGenerate = async () => {
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
        setIndent(many ? "  " : "");

        const pending = await generateOne(entry, { name, renames });
        if (pending > 0) {
            unfinishedFields += pending;
            unfinishedSchemas++;
        }
    }

    setIndent("");

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
