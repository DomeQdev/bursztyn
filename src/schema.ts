import { SnapshotBuilder } from "./builder.ts";
import {
    enforcement,
    isBundle,
    MissingMigrationsError,
    SchemaDriftError,
    UnfinishedMigrationError,
    type MigrationBundle,
} from "./bundle.ts";
import { BursztynError, SchemaMismatchError, type FieldDiff } from "./errors.ts";
import {
    createReaders,
    createReadersFromHeader,
    diffManifest,
    inspect,
    readHeader,
    toBytes,
    type SnapshotInfo,
} from "./format.ts";
import { compileSchema, type CompiledSchema, type FieldLayout } from "./layout.ts";
import {
    migrateSnapshot,
    resolveChain,
    type MigrateOptions,
    type Migration,
    type MigrationReport,
    type MigrationStep,
    type MigrationTarget,
} from "./migrate.ts";
import { STRING_TABLE_SIGNATURE } from "./strings.ts";
import type { NoInference, Readers, SchemaShape, SnapshotSource } from "./types.ts";

export interface SchemaDefinition<S extends SchemaShape> {
    fields: S;
    version?: number;
    migrations?: Migration<NoInference<S>>[] | MigrationBundle<NoInference<S>>;
}

export interface OpenOptions extends MigrateOptions {
    migrate?: boolean;
}

export interface OpenResult<S extends SchemaShape> {
    readers: Readers<S>;
    bytes: Uint8Array;
    report: MigrationReport;
}

export class Schema<S extends SchemaShape> implements MigrationTarget<S> {
    public readonly fields: S;
    public readonly version: number;
    public readonly migrations: readonly Migration<S>[];
    public readonly compiled: CompiledSchema<S>;

    constructor(definition: SchemaDefinition<S>) {
        this.fields = definition.fields;
        this.compiled = compileSchema(definition.fields);

        const declared = definition.migrations;
        const bundle = isBundle(declared) ? declared : undefined;
        this.migrations = isBundle(declared)
            ? (declared.migrations as Migration<S>[])
            : (declared ?? []);

        if (bundle && definition.version !== undefined) {
            throw new BursztynError(
                "`version` is managed by the bursztyn CLI — remove it from defineSchema().",
            );
        }
        this.version = bundle ? bundle.version : (definition.version ?? 0);

        const stringTables = this.compiled.layout.filter(
            (entry) => entry.signature === STRING_TABLE_SIGNATURE,
        );
        if (stringTables.length !== 1) {
            throw new BursztynError(
                `A schema needs exactly one stringTable() field, found ${stringTables.length}.`,
            );
        }

        if (bundle && enforcement.enabled) this.enforce(bundle);

        if (this.migrations.length > 0) {
            const landings = this.migrations.map((migration) => migration.to);
            const latest = Math.max(...landings);
            if (latest !== this.version) {
                throw new BursztynError(
                    `The last migration lands on version ${latest} but the schema declares version ${this.version}.`,
                );
            }

            const earliest = Math.min(...this.migrations.map((migration) => migration.from));
            resolveChain(this.migrations, earliest, this.version);
        }
    }

    private enforce(bundle: MigrationBundle) {
        // `bundle.name` is set when the project has several schemas, so every
        // refusal can say which one it is talking about.
        if (bundle.hash === 0n && bundle.migrations.length === 0) {
            throw new MissingMigrationsError(bundle.name);
        }

        if (bundle.hash !== this.compiled.hash) {
            throw new SchemaDriftError(
                bundle.hash,
                this.compiled.hash,
                diffManifest(bundle.manifest, this.compiled.layout),
                bundle.name,
            );
        }

        if (bundle.unfinished.length > 0) {
            throw new UnfinishedMigrationError(bundle.unfinished, bundle.name);
        }
    }

    get hash(): bigint {
        return this.compiled.hash;
    }

    get layout(): FieldLayout[] {
        return this.compiled.layout;
    }

    builder(): SnapshotBuilder<S> {
        return new SnapshotBuilder(this.compiled, this.version);
    }

    diff(source: SnapshotSource): FieldDiff[] {
        return diffManifest(readHeader(source).manifest, this.compiled.layout);
    }

    matches(source: SnapshotSource): boolean {
        try {
            const header = readHeader(source);
            return header.schemaHash === this.compiled.hash && header.schemaVersion === this.version;
        } catch {
            return false;
        }
    }

    inspect(source: SnapshotSource): SnapshotInfo {
        return inspect(source);
    }

    read(source: SnapshotSource): Readers<S> {
        const header = readHeader(source);
        if (header.schemaHash !== this.compiled.hash) {
            throw new SchemaMismatchError(
                this.compiled.hash,
                header.schemaHash,
                diffManifest(header.manifest, this.compiled.layout),
                this.migrations.length > 0
                    ? `Snapshot is at version ${header.schemaVersion}, this build is at ${this.version}. ` +
                          `Use open(source, { migrate: true }) to run the migration chain.`
                    : `Rebuild the snapshot, or declare a migration to version ${this.version}.`,
            );
        }

        return createReadersFromHeader(this.compiled, header);
    }

    async migrate(
        source: SnapshotSource,
        options: MigrateOptions = {},
    ): Promise<{ bytes: Uint8Array; report: MigrationReport }> {
        return migrateSnapshot(this, source, options);
    }

    async open(source: SnapshotSource, options: OpenOptions = {}): Promise<OpenResult<S>> {
        const bytes = toBytes(source);
        const header = readHeader(bytes);

        if (header.schemaHash === this.compiled.hash && header.schemaVersion === this.version) {
            return {
                readers: createReadersFromHeader(this.compiled, header),
                bytes,
                report: { migrated: false, from: header.schemaVersion, to: this.version, steps: [] },
            };
        }

        if (options.migrate === false) {
            throw new SchemaMismatchError(
                this.compiled.hash,
                header.schemaHash,
                diffManifest(header.manifest, this.compiled.layout),
                "Migration is disabled for this call.",
            );
        }

        const migrated = await migrateSnapshot(this, bytes, options);
        return {
            readers: createReaders(this.compiled, migrated.bytes),
            bytes: migrated.bytes,
            report: migrated.report,
        };
    }
}

export const defineSchema = <S extends SchemaShape>(definition: SchemaDefinition<S>): Schema<S> =>
    new Schema(definition);

export function migration<S extends SchemaShape>(spec: Migration<S>): Migration<S>;
export function migration<S extends SchemaShape>(spec: MigrationStep<S>): MigrationStep<S>;
export function migration(spec: unknown): unknown {
    return spec;
}
