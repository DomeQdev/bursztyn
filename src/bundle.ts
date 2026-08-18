import { BursztynError, formatDiff, type FieldDiff } from "./errors.ts";
import type { ManifestEntry } from "./format.ts";
import type { Migration, MigrationStep } from "./migrate.ts";
import type { SchemaShape } from "./types.ts";

export const enforcement = { enabled: true };

export interface MigrationBundleInput<S extends SchemaShape = SchemaShape> {
    hash: string;
    /** Which schema this folder tracks — written by the CLI when a project has several. */
    name?: string;
    fields?: [name: string, signature: string, sectionCount: number][];
    entries: MigrationStep<S>[];
}

export interface MigrationBundle<S extends SchemaShape = SchemaShape> {
    readonly kind: "bursztyn.bundle";
    readonly name?: string;
    readonly hash: bigint;
    readonly version: number;
    readonly manifest: ManifestEntry[];
    readonly migrations: Migration<S>[];
    readonly unfinished: { id: string; pending: string[] }[];
}

export const defineMigrations = <S extends SchemaShape = SchemaShape>(
    input: MigrationBundleInput<S>,
): MigrationBundle<S> => {
    const migrations = input.entries.map((entry, index) => ({
        ...entry,
        from: index,
        to: index + 1,
    }));

    for (const [index, entry] of input.entries.entries()) {
        if (!entry.id) {
            throw new BursztynError(`Migration at position ${index} in the bundle has no id.`);
        }
    }

    return {
        kind: "bursztyn.bundle",
        name: input.name,
        hash: BigInt(input.hash),
        version: migrations.length,
        manifest: (input.fields ?? []).map(([name, signature, sectionCount]) => ({
            name,
            signature,
            sectionCount,
        })),
        migrations,
        unfinished: input.entries
            .filter((entry) => (entry.pending?.length ?? 0) > 0)
            .map((entry) => ({ id: entry.id, pending: entry.pending! })),
    };
};

export const isBundle = (value: unknown): value is MigrationBundle =>
    typeof value === "object" && value !== null && (value as MigrationBundle).kind === "bursztyn.bundle";

/**
 * A project with several schemas has several folders, and only the folder that
 * drifted needs regenerating — so the fix names it.
 */
export const generateCommand = (name?: string): string =>
    name ? `bursztyn generate --only ${name}` : "bursztyn generate";

export class SchemaDriftError extends BursztynError {
    constructor(
        public readonly expected: bigint,
        public readonly actual: bigint,
        public readonly diff: FieldDiff[],
        public readonly schemaName?: string,
    ) {
        const body =
            diff.length > 0
                ? formatDiff(diff)
                : "  (the field list is identical — only the generated hash differs)";

        super(
            `${schemaName ? `Schema "${schemaName}" has` : "Your schema has"} changes ` +
                `that are not in a migration:\n\n${body}\n\n` +
                `  Run:  ${generateCommand(schemaName)}\n`,
        );
    }
}

export class UnfinishedMigrationError extends BursztynError {
    constructor(
        public readonly unfinished: { id: string; pending: string[] }[],
        public readonly schemaName?: string,
    ) {
        const body = unfinished
            .map((entry) => `  ${entry.id}\n${entry.pending.map((name) => `    - ${name}`).join("\n")}`)
            .join("\n");

        super(
            `Unfinished migrations${schemaName ? ` in "${schemaName}"` : ""} — ` +
                `these fields are still placeholders:\n\n${body}\n\n` +
                `  Fill in up(), then delete those names from \`pending\`.\n`,
        );
    }
}

export class MissingMigrationsError extends BursztynError {
    constructor(public readonly schemaName?: string) {
        super(
            `${schemaName ? `Schema "${schemaName}"` : "This schema"} is managed by the bursztyn CLI ` +
                `but no migrations have been generated yet.\n\n` +
                `  Run:  ${generateCommand(schemaName)}\n`,
        );
    }
}

export const todo = (field: string, hint?: string): never => {
    throw new BursztynError(
        `Migration placeholder for "${field}"${hint ? ` (${hint})` : ""} was never filled in.`,
    );
};
