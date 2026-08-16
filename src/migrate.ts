import { SnapshotBuilder } from "./builder.js";
import {
    BursztynError,
    CarryConflictError,
    MigrationDataLossError,
    MigrationPathError,
} from "./errors.js";
import {
    createReadersFromLayout,
    layoutFromManifest,
    readHeader,
    sectionBytes,
    toBytes,
    type SnapshotHeader,
} from "./format.js";
import { compileSchema, type CompiledSchema, type FieldLayout } from "./layout.js";
import { fieldFromSignature } from "./registry.js";
import { StringInterner, STRING_TABLE_SIGNATURE, type StringReader } from "./strings.js";
import type { AnyTypedArray, Builders, Field, SchemaShape, SnapshotSource } from "./types.js";

export interface PreviousSnapshot {
    readonly version: number;
    readonly names: string[];
    readonly strings: StringReader;
    has(name: string): boolean;
    signature(name: string): string | undefined;
    get<T = unknown>(name: string): T;
    tryGet<T = unknown>(name: string): T | undefined;
}

export interface MigrationContext<S extends SchemaShape> {
    readonly previous: PreviousSnapshot;
    readonly builders: Builders<S> & Record<string, any>;
    readonly strings: StringInterner;
    readonly carried: ReadonlySet<string>;
    log(message: string): void;
}

export type FieldDefinitions = string[] | Record<string, Field<any, any>>;

export interface MigrationStep<S extends SchemaShape = SchemaShape> {
    id: string;
    description?: string;
    defines?: FieldDefinitions;
    renames?: Record<string, string>;
    drops?: string[];
    rebuilds?: string[];
    pending?: string[];
    up?(ctx: MigrationContext<S>): void | Promise<void>;
}

export interface Migration<S extends SchemaShape = SchemaShape>
    extends Omit<MigrationStep<S>, "id"> {
    id?: string;
    from: number;
    to: number;
}

export interface MigrationStepReport {
    from: number;
    to: number;
    description?: string;
    carried: string[];
    rebuilt: string[];
    added: string[];
    dropped: string[];
    renamed: { from: string; to: string }[];
    bytesBefore: number;
    bytesAfter: number;
}

export interface MigrationReport {
    migrated: boolean;
    from: number;
    to: number;
    steps: MigrationStepReport[];
}

export interface MigrationTarget<S extends SchemaShape> {
    readonly version: number;
    readonly fields: S;
    readonly compiled: CompiledSchema<S>;
    readonly migrations: readonly Migration<S>[];
}

export interface MigrateOptions {
    log?: (message: string) => void;
    shared?: boolean;
}

export const resolveChain = <S extends SchemaShape>(
    migrations: readonly Migration<S>[],
    from: number,
    to: number,
): Migration<S>[] => {
    if (from === to) return [];
    if (from > to) {
        throw new MigrationPathError(
            from,
            to,
            "the snapshot was written by a newer build; migrations only run forward",
        );
    }

    const byFrom = new Map<number, Migration<S>>();
    for (const migration of migrations) {
        if (migration.to <= migration.from) {
            throw new MigrationPathError(
                from,
                to,
                `migration ${migration.from} -> ${migration.to} does not move forward`,
            );
        }
        if (byFrom.has(migration.from)) {
            throw new MigrationPathError(from, to, `two migrations both start at version ${migration.from}`);
        }
        byFrom.set(migration.from, migration);
    }

    const chain: Migration<S>[] = [];
    let version = from;

    while (version < to) {
        const migration = byFrom.get(version);
        if (!migration) {
            throw new MigrationPathError(
                from,
                to,
                `no migration starts at version ${version} (declared: ${[...byFrom.keys()].sort((a, b) => a - b).join(", ") || "none"})`,
            );
        }
        chain.push(migration);
        version = migration.to;
    }

    if (version !== to) {
        throw new MigrationPathError(from, to, `the chain overshoots to version ${version}`);
    }

    return chain;
};

const stepName = (migration: Migration<any>) => migration.id ?? `${migration.from} -> ${migration.to}`;

const remapSignature = (signature: string, renames: Record<string, string>): string => {
    if (!signature.startsWith("hashLookup:")) return signature;
    const verifyVia = signature.slice("hashLookup:".length);
    return `hashLookup:${renames[verifyVia] ?? verifyVia}`;
};

const definitionEntries = <S extends SchemaShape>(
    migration: Migration<S>,
    target: MigrationTarget<S>,
): [string, Field<any, any>][] => {
    const defines = migration.defines;
    if (!defines) return [];

    if (Array.isArray(defines)) {
        return defines.map((name) => {
            const field = (target.fields as SchemaShape)[name];
            if (!field) {
                throw new BursztynError(
                    `Migration ${stepName(migration)} defines "${name}", but the current schema has no such ` +
                        `field. Give it an explicit definition: defines: { ${name}: <field>() }.`,
                );
            }
            return [name, field] as [string, Field<any, any>];
        });
    }

    return Object.entries(defines);
};

const deriveFields = <S extends SchemaShape>(
    migration: Migration<S>,
    target: MigrationTarget<S>,
    header: SnapshotHeader,
): { name: string; field: Field<any, any> }[] => {
    const drops = new Set(migration.drops ?? []);
    const renames = migration.renames ?? {};
    const derived: { name: string; field: Field<any, any> }[] = [];

    for (const entry of header.manifest) {
        if (drops.has(entry.name)) continue;
        derived.push({
            name: renames[entry.name] ?? entry.name,
            field: fieldFromSignature(remapSignature(entry.signature, renames)),
        });
    }

    for (const [name, field] of definitionEntries(migration, target)) {
        const index = derived.findIndex((item) => item.name === name);
        if (index === -1) derived.push({ name, field });
        else derived[index] = { name, field };
    }

    const seen = new Set<string>();
    for (const item of derived) {
        if (seen.has(item.name)) {
            throw new BursztynError(
                `Migration ${stepName(migration)} produces two fields named "${item.name}".`,
            );
        }
        seen.add(item.name);
    }

    return derived;
};

const assertDerivedMatchesTarget = <S extends SchemaShape>(
    migration: Migration<S>,
    target: MigrationTarget<S>,
    derived: { name: string; field: Field<any, any> }[],
) => {
    const derivedByName = new Map(derived.map((item) => [item.name, item.field.signature()]));
    const problems: string[] = [];

    for (const entry of target.compiled.layout) {
        const signature = derivedByName.get(entry.name);
        if (signature === undefined) {
            problems.push(
                `  "${entry.name}" is in the schema but no migration creates it — add it to \`defines\`.`,
            );
        } else if (signature !== entry.signature) {
            problems.push(
                `  "${entry.name}" ends up as ${signature} but the schema declares ${entry.signature} — add it to \`defines\`.`,
            );
        }
        derivedByName.delete(entry.name);
    }

    for (const name of derivedByName.keys()) {
        problems.push(
            `  "${name}" survives the migration but is not in the schema — add it to \`drops\` or \`renames\`.`,
        );
    }

    if (problems.length > 0) {
        throw new BursztynError(
            `Migration ${stepName(migration)} does not land on the current schema:\n${problems.join("\n")}`,
        );
    }
};

const sectionsOf = (header: SnapshotHeader, layout: FieldLayout): Uint8Array[] => {
    const sections: Uint8Array[] = [];
    for (let i = 0; i < layout.sectionCount; i++) {
        sections.push(sectionBytes(header, layout.startSectionId + i));
    }
    return sections;
};

const byteLengthOf = (sections: Uint8Array[]): number => {
    let total = 0;
    for (const section of sections) total += section.byteLength;
    return total;
};

const asBytes = (data: AnyTypedArray): Uint8Array =>
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const finalizeOrNull = (layout: FieldLayout, builder: unknown): Uint8Array[] | null => {
    try {
        return layout.field.finalize(builder, layout.name).map((section) => asBytes(section.data));
    } catch {
        return null;
    }
};

const builderWasWritten = (layout: FieldLayout, builder: unknown): boolean => {
    const actual = finalizeOrNull(layout, builder);
    if (actual === null) return true;

    const pristine = finalizeOrNull(
        layout,
        layout.field.createBuilder({ strings: new StringInterner() }),
    );
    if (pristine === null) return true;
    if (pristine.length !== actual.length) return true;

    for (let i = 0; i < actual.length; i++) {
        if (actual[i].byteLength !== pristine[i].byteLength) return true;
        for (let b = 0; b < actual[i].length; b++) {
            if (actual[i][b] !== pristine[i][b]) return true;
        }
    }

    return false;
};

const runStep = async <S extends SchemaShape>(
    migration: Migration<S>,
    target: MigrationTarget<S>,
    input: Uint8Array,
    isLast: boolean,
    options: MigrateOptions,
): Promise<{ bytes: Uint8Array; report: MigrationStepReport }> => {
    const header = readHeader(input);
    const sourceLayout = layoutFromManifest(header.manifest);
    const sourceByName = new Map(sourceLayout.map((entry) => [entry.name, entry]));
    const readers = createReadersFromLayout(sourceLayout, header);

    const derived = deriveFields(migration, target, header);
    if (isLast) assertDerivedMatchesTarget(migration, target, derived);

    const compiled = isLast
        ? target.compiled
        : (compileSchema(Object.fromEntries(derived.map((item) => [item.name, item.field]))) as CompiledSchema<S>);

    const stringsLayout = sourceLayout.find((entry) => entry.signature === STRING_TABLE_SIGNATURE)!;
    const previousStrings = readers[stringsLayout.name] as StringReader;
    const builder = new SnapshotBuilder<S>(
        compiled,
        migration.to,
        StringInterner.hydrate(previousStrings),
    );

    const renames = migration.renames ?? {};
    const reverseRenames = new Map(Object.entries(renames).map(([from, to]) => [to, from]));
    const rebuilds = new Set(migration.rebuilds ?? []);
    const drops = new Set(migration.drops ?? []);

    const report: MigrationStepReport = {
        from: migration.from,
        to: migration.to,
        description: migration.description,
        carried: [],
        rebuilt: [],
        added: [],
        dropped: [...drops],
        renamed: Object.entries(renames).map(([from, to]) => ({ from, to })),
        bytesBefore: input.byteLength,
        bytesAfter: 0,
    };

    const sourceNameOf = new Map<string, string>();

    for (const entry of compiled.layout) {
        if (entry.signature === STRING_TABLE_SIGNATURE) continue;

        const sourceName = reverseRenames.get(entry.name) ?? entry.name;
        const source = sourceByName.get(sourceName);

        if (!source) {
            report.added.push(entry.name);
            continue;
        }

        sourceNameOf.set(entry.name, sourceName);

        if (remapSignature(source.signature, renames) === entry.signature && !rebuilds.has(entry.name)) {
            builder.carry(entry.name, sectionsOf(header, source));
            report.carried.push(entry.name);
        } else {
            report.rebuilt.push(entry.name);
        }
    }

    if (migration.up) {
        const previous: PreviousSnapshot = {
            version: header.schemaVersion,
            names: sourceLayout.map((entry) => entry.name),
            strings: previousStrings,
            has: (name) => sourceByName.has(name),
            signature: (name) => sourceByName.get(name)?.signature,
            tryGet: <T>(name: string) => readers[name] as T | undefined,
            get: <T>(name: string) => {
                if (!(name in readers)) {
                    throw new BursztynError(
                        `Migration ${stepName(migration)} asked for field "${name}", which the snapshot ` +
                            `does not have. Available: ${sourceLayout.map((entry) => entry.name).join(", ")}`,
                    );
                }
                return readers[name] as T;
            },
        };

        await migration.up({
            previous,
            builders: builder.builders,
            strings: builder.strings,
            carried: new Set(report.carried),
            log: options.log ?? (() => {}),
        });
    }

    for (const name of report.carried) {
        if (builderWasWritten(compiled.layoutByName[name], (builder.builders as any)[name])) {
            throw new CarryConflictError(name, stepName(migration));
        }
    }

    const emitted = builder.emit();

    for (const field of emitted) {
        if (builder.isCarried(field.name)) continue;

        const sourceName = sourceNameOf.get(field.name);
        if (sourceName === undefined || drops.has(sourceName) || drops.has(field.name)) continue;

        const before = byteLengthOf(sectionsOf(header, sourceByName.get(sourceName)!));
        if (before > 0 && byteLengthOf(field.sections) === 0) {
            throw new MigrationDataLossError(field.name, stepName(migration), before);
        }
    }

    const bytes =
        isLast && options.shared ? new Uint8Array(builder.buildShared()) : builder.build();

    report.bytesAfter = bytes.byteLength;
    return { bytes, report };
};

export const migrateSnapshot = async <S extends SchemaShape>(
    target: MigrationTarget<S>,
    source: SnapshotSource,
    options: MigrateOptions = {},
): Promise<{ bytes: Uint8Array; report: MigrationReport }> => {
    let bytes = toBytes(source);
    const header = readHeader(bytes);
    const from = header.schemaVersion;

    if (from === target.version && header.schemaHash === target.compiled.hash) {
        return { bytes, report: { migrated: false, from, to: from, steps: [] } };
    }

    const chain = resolveChain(target.migrations, from, target.version);
    if (chain.length === 0) {
        throw new MigrationPathError(
            from,
            target.version,
            "the snapshot claims the current version but its layout differs from this build's schema. " +
                "Bump the schema version and declare a migration",
        );
    }

    const steps: MigrationStepReport[] = [];

    for (let i = 0; i < chain.length; i++) {
        const isLast = i === chain.length - 1;
        options.log?.(`bursztyn: migrating ${stepName(chain[i])}${chain[i].description ? ` (${chain[i].description})` : ""}`);
        const result = await runStep(chain[i], target, bytes, isLast, options);
        bytes = result.bytes;
        steps.push(result.report);
    }

    return { bytes, report: { migrated: true, from, to: target.version, steps } };
};
