import { diffManifest, type ManifestEntry } from "./format.ts";
import {
    barrelPath,
    journalPath,
    migrationNumber,
    migrationPath,
    snapshotManifest,
    snapshotPath,
    type Journal,
    type JournalEntry,
    type SchemaSnapshot,
} from "./journal.ts";
import type { CompiledSchema } from "./layout.ts";
import type { FieldDiff } from "./errors.ts";

const COLUMN_ALIASES: Record<string, string> = {
    "Uint8Array:1": "u8()",
    "Uint16Array:1": "u16()",
    "Uint32Array:1": "u32()",
    "Int8Array:1": "i8()",
    "Int16Array:1": "i16()",
    "Int32Array:1": "i32()",
    "Float32Array:1": "f32()",
    "Float64Array:1": "f64()",
    "Int32Array:2": "i32Pair()",
    strRef: "stringRef()",
};

const renderColumn = (tag: string, imports: Set<string>): string => {
    const alias = COLUMN_ALIASES[tag];
    if (alias) {
        imports.add(alias.slice(0, alias.indexOf("(")));
        return alias;
    }

    const sep = tag.lastIndexOf(":");
    imports.add("numColumn");
    return `numColumn(${tag.slice(0, sep)}, ${tag.slice(sep + 1)})`;
};

const renderColumns = (spec: string, imports: Set<string>): string => {
    if (spec.length === 0) return "{}";

    const columns = spec.split(",").map((part) => {
        const eq = part.indexOf("=");
        return `${part.slice(0, eq)}: ${renderColumn(part.slice(eq + 1), imports)}`;
    });

    return `{ ${columns.join(", ")} }`;
};

export const renderField = (signature: string, imports: Set<string>): string => {
    const sep = signature.indexOf(":");
    const kind = sep === -1 ? signature : signature.slice(0, sep);
    const rest = sep === -1 ? "" : signature.slice(sep + 1);

    switch (kind) {
        case "stringTable":
        case "stringRefArray":
        case "singleStringRef":
        case "trigramIndex":
        case "sortedU32Index":
        case "rawBytes":
            imports.add(kind);
            return `${kind}()`;
        case "num":
            imports.add("numArray");
            return `numArray(${rest})`;
        case "hashLookup":
            imports.add("hashLookup");
            return rest.length > 0 ? `hashLookup({ verifyVia: "${rest}" })` : "hashLookup()";
        case "bucketArray":
        case "keyedIndex":
            imports.add(kind);
            return `${kind}(${renderColumn(rest, imports)})`;
        case "multiBucketArray":
            imports.add(kind);
            return `${kind}(${renderColumns(rest, imports)})`;
        case "pairIndex2":
            imports.add("pairIndex");
            return `pairIndex(${renderColumns(rest, imports)})`;
        // A legacy "pairIndex:" has no constructor of its own on purpose, so it
        // falls through to fieldFromSignature() and a mid-chain step keeps
        // rebuilding the layout the old snapshot actually holds.
        default:
            imports.add("fieldFromSignature");
            return `fieldFromSignature("${signature}")`;
    }
};

const READER_TYPES: Record<string, string> = {
    stringRefArray: "Uint32Array",
};

const readerType = (signature: string): string | undefined => {
    if (signature.startsWith("num:")) return signature.slice(4);
    return READER_TYPES[signature];
};

const snakeCase = (name: string): string =>
    name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .toLowerCase();

export interface SchemaChange {
    added: { name: string; signature: string }[];
    removed: { name: string; signature: string }[];
    changed: { name: string; before: string; after: string }[];
    renamed: { from: string; to: string; signature: string }[];
    reordered: boolean;
}

export const describeChange = (
    diff: FieldDiff[],
    renames: Record<string, string>,
    previous: ManifestEntry[],
): SchemaChange => {
    const renamedFrom = new Set(Object.keys(renames));
    const renamedTo = new Set(Object.values(renames));
    const signatureOf = new Map(previous.map((entry) => [entry.name, entry.signature]));

    return {
        added: diff
            .filter((entry) => entry.kind === "added" && !renamedTo.has(entry.name))
            .map((entry) => ({ name: entry.name, signature: (entry as any).signature })),
        removed: diff
            .filter((entry) => entry.kind === "removed" && !renamedFrom.has(entry.name))
            .map((entry) => ({ name: entry.name, signature: (entry as any).signature })),
        changed: diff
            .filter((entry) => entry.kind === "changed")
            .map((entry) => entry as Extract<FieldDiff, { kind: "changed" }>),
        renamed: Object.entries(renames).map(([from, to]) => ({
            from,
            to,
            signature: signatureOf.get(from) ?? "",
        })),
        reordered: diff.some((entry) => entry.kind === "moved"),
    };
};

export const isEmptyChange = (change: SchemaChange): boolean =>
    change.added.length === 0 &&
    change.removed.length === 0 &&
    change.changed.length === 0 &&
    change.renamed.length === 0 &&
    !change.reordered;

export const suggestName = (change: SchemaChange): string => {
    const parts: string[] = [];
    if (change.added.length === 1) parts.push(`add_${snakeCase(change.added[0].name)}`);
    else if (change.added.length > 1) parts.push(`add_${change.added.length}_fields`);

    if (change.removed.length === 1) parts.push(`drop_${snakeCase(change.removed[0].name)}`);
    else if (change.removed.length > 1) parts.push(`drop_${change.removed.length}_fields`);

    if (change.changed.length === 1) parts.push(`change_${snakeCase(change.changed[0].name)}`);
    else if (change.changed.length > 1) parts.push(`change_${change.changed.length}_fields`);

    if (change.renamed.length === 1) {
        parts.push(`rename_${snakeCase(change.renamed[0].from)}_to_${snakeCase(change.renamed[0].to)}`);
    } else if (change.renamed.length > 1) parts.push(`rename_${change.renamed.length}_fields`);

    if (parts.length === 0) return change.reordered ? "reorder_fields" : "update_schema";
    return parts.slice(0, 2).join("_and_");
};

export const renameCandidates = (
    diff: FieldDiff[],
): { removed: string; added: string; signature: string }[] => {
    const candidates: { removed: string; added: string; signature: string }[] = [];

    for (const entry of diff) {
        if (entry.kind !== "removed") continue;
        for (const other of diff) {
            if (other.kind === "added" && other.signature === entry.signature) {
                candidates.push({ removed: entry.name, added: other.name, signature: entry.signature });
            }
        }
    }

    return candidates;
};

const renderMigrationFile = (
    id: string,
    change: SchemaChange,
    previous: ManifestEntry[],
    importFrom: string,
): string => {
    const imports = new Set<string>(["migration"]);
    const lines: string[] = [];

    const definitions = [
        ...change.added.map((field) => ({ name: field.name, signature: field.signature })),
        ...change.changed.map((field) => ({ name: field.name, signature: field.after })),
    ];

    lines.push(`    id: "${id}",`);

    if (definitions.length > 0) {
        lines.push("    defines: {");
        for (const field of definitions) {
            lines.push(`        ${field.name}: ${renderField(field.signature, imports)},`);
        }
        lines.push("    },");
    }

    if (change.renamed.length > 0) {
        const pairs = change.renamed.map((entry) => `${entry.from}: "${entry.to}"`);
        lines.push(`    renames: { ${pairs.join(", ")} },`);
    }

    if (change.removed.length > 0) {
        lines.push(`    drops: [${change.removed.map((field) => `"${field.name}"`).join(", ")}],`);
    }

    if (definitions.length > 0) {
        imports.add("todo");
        lines.push(`    pending: [${definitions.map((field) => `"${field.name}"`).join(", ")}],`);
        lines.push("    up({ previous, builders }) {");

        for (const field of definitions) {
            const changed = change.changed.find((entry) => entry.name === field.name);
            lines.push(
                changed
                    ? `        // ${field.name}: ${changed.before} -> ${changed.after}`
                    : `        // ${field.name} — new field (${field.signature})`,
            );

            if (changed) {
                const type = readerType(changed.before);
                if (type) {
                    lines.push(
                        `        // const old = previous.get<${type}>("${field.name}");`,
                    );
                }
            }

            lines.push(`        todo("${field.name}");`);
        }

        lines.push("    },");
    }

    const header =
        definitions.length > 0
            ? `// Generated by bursztyn. Fill in up(), then delete the names from \`pending\`.\n` +
              `// Carried over untouched: ${previous
                  .map((entry) => entry.name)
                  .filter((name) => !definitions.some((field) => field.name === name))
                  .join(", ")}\n`
            : "// Generated by bursztyn. Nothing to fill in — every field is carried over.\n";

    return (
        `import { ${[...imports].sort().join(", ")} } from "${importFrom}";\n\n` +
        header +
        `export default migration({\n${lines.join("\n")}\n});\n`
    );
};

const renderBarrel = (
    journal: Journal,
    snapshot: SchemaSnapshot,
    importFrom: string,
): string => {
    const steps = journal.entries.filter((entry) => entry.version > 0);
    const imports = steps
        .map((entry) => `import m${migrationNumber(entry.version)} from "./${entry.id}";`)
        .join("\n");

    const fields = snapshot.fields
        .map(([name, signature, sectionCount]) => `        ["${name}", "${signature}", ${sectionCount}],`)
        .join("\n");

    return (
        `// Generated by bursztyn — do not edit.\n` +
        `import { defineMigrations } from "${importFrom}";\n` +
        (imports ? `${imports}\n` : "") +
        `\nexport default defineMigrations({\n` +
        `    hash: "${snapshot.hash}",\n` +
        `    fields: [\n${fields}\n    ],\n` +
        `    entries: [${steps.map((entry) => `m${migrationNumber(entry.version)}`).join(", ")}],\n` +
        `});\n`
    );
};

export interface GenerateOptions {
    compiled: CompiledSchema<any>;
    journal: Journal;
    previous: SchemaSnapshot | null;
    out: string;
    importFrom: string;
    name?: string;
    renames?: Record<string, string>;
    timestamp: string;
}

export interface GeneratedFile {
    path: string;
    content: string;
}

export interface GenerateResult {
    status: "up-to-date" | "initial" | "generated";
    id?: string;
    version?: number;
    change?: SchemaChange;
    files: GeneratedFile[];
}

export const planGeneration = (options: GenerateOptions): GenerateResult => {
    const { compiled, journal, previous, out, importFrom, timestamp } = options;
    const fields = compiled.layout.map(
        (entry) => [entry.name, entry.signature, entry.sectionCount] as [string, string, number],
    );

    if (!previous) {
        const snapshot: SchemaSnapshot = {
            version: 0,
            id: "0000_initial",
            hash: compiled.hash.toString(),
            fields,
        };
        const nextJournal: Journal = {
            ...journal,
            entries: [{ version: 0, id: snapshot.id, hash: snapshot.hash, createdAt: timestamp }],
        };

        return {
            status: "initial",
            id: snapshot.id,
            version: 0,
            files: [
                { path: snapshotPath(out, 0), content: `${JSON.stringify(snapshot, null, 2)}\n` },
                { path: journalPath(out), content: `${JSON.stringify(nextJournal, null, 2)}\n` },
                { path: barrelPath(out), content: renderBarrel(nextJournal, snapshot, importFrom) },
            ],
        };
    }

    const previousManifest = snapshotManifest(previous);
    const diff = diffManifest(previousManifest, compiled.layout);
    const change = describeChange(diff, options.renames ?? {}, previousManifest);

    if (isEmptyChange(change)) return { status: "up-to-date", files: [] };

    const version = previous.version + 1;
    const id = `${migrationNumber(version)}_${options.name ?? suggestName(change)}`;

    const snapshot: SchemaSnapshot = { version, id, hash: compiled.hash.toString(), fields };
    const nextJournal: Journal = {
        ...journal,
        entries: [...journal.entries, { version, id, hash: snapshot.hash, createdAt: timestamp }],
    };

    return {
        status: "generated",
        id,
        version,
        change,
        files: [
            {
                path: migrationPath(out, version, id.slice(5)),
                content: renderMigrationFile(id, change, previousManifest, importFrom),
            },
            { path: snapshotPath(out, version), content: `${JSON.stringify(snapshot, null, 2)}\n` },
            { path: journalPath(out), content: `${JSON.stringify(nextJournal, null, 2)}\n` },
            { path: barrelPath(out), content: renderBarrel(nextJournal, snapshot, importFrom) },
        ],
    };
};
