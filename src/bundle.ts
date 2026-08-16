import { BursztynError, formatDiff, type FieldDiff } from "./errors.js";
import type { ManifestEntry } from "./format.js";
import type { Migration, MigrationStep } from "./migrate.js";
import type { SchemaShape } from "./types.js";

export const enforcement = { enabled: true };

export interface MigrationBundleInput<S extends SchemaShape = SchemaShape> {
    hash: string;
    fields?: [name: string, signature: string, sectionCount: number][];
    entries: MigrationStep<S>[];
}

export interface MigrationBundle<S extends SchemaShape = SchemaShape> {
    readonly kind: "bursztyn.bundle";
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

export class SchemaDriftError extends BursztynError {
    constructor(
        public readonly expected: bigint,
        public readonly actual: bigint,
        public readonly diff: FieldDiff[],
    ) {
        const body =
            diff.length > 0
                ? formatDiff(diff)
                : "  (the field list is identical — only the generated hash differs)";

        super(
            `Your schema has changes that are not in a migration:\n\n${body}\n\n` +
                `  Run:  bursztyn generate\n`,
        );
    }
}

export class UnfinishedMigrationError extends BursztynError {
    constructor(public readonly unfinished: { id: string; pending: string[] }[]) {
        const body = unfinished
            .map((entry) => `  ${entry.id}\n${entry.pending.map((name) => `    - ${name}`).join("\n")}`)
            .join("\n");

        super(
            `Unfinished migrations — these fields are still placeholders:\n\n${body}\n\n` +
                `  Fill in up(), then delete those names from \`pending\`.\n`,
        );
    }
}

export class MissingMigrationsError extends BursztynError {
    constructor() {
        super(
            `This schema is managed by the bursztyn CLI but no migrations have been generated yet.\n\n` +
                `  Run:  bursztyn generate\n`,
        );
    }
}

export const todo = (field: string, hint?: string): never => {
    throw new BursztynError(
        `Migration placeholder for "${field}"${hint ? ` (${hint})` : ""} was never filled in.`,
    );
};
