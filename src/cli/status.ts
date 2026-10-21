import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diffManifest } from "../format.ts";
import { snapshotManifest } from "../journal.ts";
import { fixCommand, lastSnapshot, load, loadTargets, readJournal, type Loaded } from "./load.ts";
import { bold, dim, green, heading, red, setIndent, write, yellow } from "./terminal.ts";

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

export const runStatus = async () => {
    const targets = await loadTargets();
    const many = targets.length > 1;
    const loaded = await load(targets);
    let failing = 0;

    for (const [index, entry] of loaded.entries()) {
        if (many) heading(entry.target, index === 0);
        setIndent(many ? "  " : "");

        if (!(await statusOne(entry))) failing++;
    }

    setIndent("");

    if (failing > 0) process.exitCode = 1;
    if (!many) return;

    write("");
    write(
        failing === 0
            ? `${green("✓")} ${loaded.length} schemas up to date`
            : `${red("✗")} ${failing} of ${loaded.length} schemas need attention`,
    );
};
