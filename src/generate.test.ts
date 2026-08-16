import { describe, expect, it } from "bun:test";
import {
    bucketArray,
    defineMigrations,
    defineSchema,
    diffManifest,
    emptyJournal,
    hashLookup,
    i32Pair,
    multiBucketArray,
    numArray,
    planGeneration,
    renameCandidates,
    renderField,
    singleStringRef,
    snapshotManifest,
    stringRef,
    stringRefArray,
    stringTable,
    suggestName,
    describeChange,
    trigramIndex,
    u32,
    type Journal,
    type SchemaSnapshot,
} from "./index.ts";
import { fieldFromSignature } from "./registry.ts";
import { MissingMigrationsError, SchemaDriftError, UnfinishedMigrationError } from "./bundle.ts";

const baseFields = {
    strings: stringTable(),
    city: singleStringRef(),
    stopLookup: hashLookup({ verifyVia: "stopId" }),
    stopId: stringRefArray(),
    stopName: stringRefArray(),
    stopLat: numArray(Int32Array),
    stopRoutes: bucketArray(u32()),
};

const TIMESTAMP = "2026-08-16T00:00:00.000Z";

const initial = (fields: any): { snapshot: SchemaSnapshot; journal: Journal } => {
    const result = planGeneration({
        compiled: defineSchema({ fields }).compiled,
        journal: emptyJournal(),
        previous: null,
        out: "./amber",
        importFrom: "bursztyn",
        timestamp: TIMESTAMP,
    });

    const snapshot = JSON.parse(
        result.files.find((file) => file.path.includes("snapshot"))!.content,
    ) as SchemaSnapshot;
    const journal = JSON.parse(
        result.files.find((file) => file.path.includes("_journal"))!.content,
    ) as Journal;

    return { snapshot, journal };
};

const generate = (fields: any, renames?: Record<string, string>) => {
    const { snapshot, journal } = initial(baseFields);
    return planGeneration({
        compiled: defineSchema({ fields }).compiled,
        journal,
        previous: snapshot,
        out: "./amber",
        importFrom: "bursztyn",
        renames,
        timestamp: TIMESTAMP,
    });
};

const migrationSource = (result: ReturnType<typeof generate>): string =>
    result.files.find((file) => file.path.endsWith(".ts") && !file.path.endsWith("index.ts"))!.content;

describe("renderField", () => {
    it("renders every field kind back to constructor source", () => {
        const cases: [string, string][] = [
            ["stringTable", "stringTable()"],
            ["stringRefArray", "stringRefArray()"],
            ["singleStringRef", "singleStringRef()"],
            ["trigramIndex", "trigramIndex()"],
            ["sortedU32Index", "sortedU32Index()"],
            ["rawBytes", "rawBytes()"],
            ["num:Uint16Array", "numArray(Uint16Array)"],
            ["hashLookup:stopId", 'hashLookup({ verifyVia: "stopId" })'],
            ["hashLookup:", "hashLookup()"],
            ["bucketArray:Uint32Array:1", "bucketArray(u32())"],
            ["keyedIndex:Int32Array:2", "keyedIndex(i32Pair())"],
            ["multiBucketArray:name=strRef,location=Int32Array:2", "multiBucketArray({ name: stringRef(), location: i32Pair() })"],
            ["pairIndex:from=Uint32Array:1,to=Uint8Array:1", "pairIndex({ from: u32(), to: u8() })"],
            ["bucketArray:Uint32Array:3", "bucketArray(numColumn(Uint32Array, 3))"],
        ];

        for (const [signature, expected] of cases) {
            expect(renderField(signature, new Set())).toBe(expected);
        }
    });

    it("round-trips through fieldFromSignature for real schema fields", () => {
        const fields = {
            ...baseFields,
            entrances: multiBucketArray({ name: stringRef(), location: i32Pair() }),
            search: trigramIndex(),
        };

        for (const entry of defineSchema({ fields }).compiled.layout) {
            expect(fieldFromSignature(entry.signature).signature()).toBe(entry.signature);
        }
    });

    it("falls back to fieldFromSignature for anything unknown", () => {
        const imports = new Set<string>();
        expect(renderField("someFutureField:x", imports)).toBe('fieldFromSignature("someFutureField:x")');
        expect(imports.has("fieldFromSignature")).toBe(true);
    });
});

describe("planGeneration", () => {
    it("initialises at version 0 without a migration file", () => {
        const result = planGeneration({
            compiled: defineSchema({ fields: baseFields }).compiled,
            journal: emptyJournal(),
            previous: null,
            out: "./amber",
            importFrom: "bursztyn",
            timestamp: TIMESTAMP,
        });

        expect(result.status).toBe("initial");
        expect(result.version).toBe(0);
        expect(result.files.map((file) => file.path)).toEqual([
            "./amber/meta/0000_snapshot.json",
            "./amber/meta/_journal.json",
            "./amber/index.ts",
        ]);
    });

    it("reports up-to-date when nothing changed", () => {
        expect(generate(baseFields).status).toBe("up-to-date");
    });

    it("generates a placeholder for an added field", () => {
        const result = generate({ ...baseFields, stopBearing: numArray(Uint16Array) });

        expect(result.status).toBe("generated");
        expect(result.id).toBe("0001_add_stop_bearing");
        expect(result.change!.added).toEqual([{ name: "stopBearing", signature: "num:Uint16Array" }]);

        const source = migrationSource(result);
        expect(source).toContain("stopBearing: numArray(Uint16Array)");
        expect(source).toContain('pending: ["stopBearing"]');
        expect(source).toContain('todo("stopBearing")');
        expect(source).toContain("Carried over untouched: strings, city");
    });

    it("generates a finished migration for a rename", () => {
        const { stopName, ...rest } = baseFields;
        const result = generate({ ...rest, stopLabel: stringRefArray() }, { stopName: "stopLabel" });

        const source = migrationSource(result);
        expect(source).toContain('renames: { stopName: "stopLabel" }');
        expect(source).not.toContain("pending");
        expect(source).not.toContain("todo");
        expect(result.id).toBe("0001_rename_stop_name_to_stop_label");
    });

    it("generates drops for a removed field", () => {
        const { stopRoutes, ...rest } = baseFields;
        const source = migrationSource(generate(rest));

        expect(source).toContain('drops: ["stopRoutes"]');
        expect(source).not.toContain("pending");
    });

    it("asks for data when a field changes type, and hints at the old reader", () => {
        const source = migrationSource(generate({ ...baseFields, stopLat: numArray(Float64Array) }));

        expect(source).toContain("stopLat: numArray(Float64Array)");
        expect(source).toContain('pending: ["stopLat"]');
        expect(source).toContain("// stopLat: num:Int32Array -> num:Float64Array");
        expect(source).toContain('previous.get<Int32Array>("stopLat")');
    });

    it("still bumps the version for a pure reorder", () => {
        const { stopLat, stopRoutes, ...rest } = baseFields;
        const result = generate({ ...rest, stopRoutes, stopLat });

        expect(result.status).toBe("generated");
        expect(result.change!.reordered).toBe(true);
        expect(migrationSource(result)).not.toContain("pending");
    });

    it("writes the field manifest into the barrel so drift can be diffed offline", () => {
        const result = generate({ ...baseFields, stopBearing: numArray(Uint16Array) });
        const barrel = result.files.find((file) => file.path.endsWith("index.ts"))!.content;

        expect(barrel).toContain('["stopBearing", "num:Uint16Array", 1]');
        expect(barrel).toContain("import m0001 from \"./0001_add_stop_bearing\"");
        expect(barrel).toContain("entries: [m0001]");
    });
});

describe("rename detection", () => {
    it("spots a disappeared/appeared pair with the same signature", () => {
        const { snapshot } = initial(baseFields);
        const { stopName, ...rest } = baseFields;
        const compiled = defineSchema({ fields: { ...rest, stopLabel: stringRefArray() } }).compiled;

        const candidates = renameCandidates(diffManifest(snapshotManifest(snapshot), compiled.layout));
        expect(candidates).toContainEqual({
            removed: "stopName",
            added: "stopLabel",
            signature: "stringRefArray",
        });
    });

    it("does not treat differently typed fields as a rename", () => {
        const { snapshot } = initial(baseFields);
        const { stopLat, ...rest } = baseFields;
        const compiled = defineSchema({ fields: { ...rest, altitude: numArray(Uint8Array) } }).compiled;

        expect(renameCandidates(diffManifest(snapshotManifest(snapshot), compiled.layout))).toEqual([]);
    });

    it("drops the pair from added/removed once the rename is confirmed", () => {
        const { snapshot } = initial(baseFields);
        const { stopName, ...rest } = baseFields;
        const compiled = defineSchema({ fields: { ...rest, stopLabel: stringRefArray() } }).compiled;
        const diff = diffManifest(snapshotManifest(snapshot), compiled.layout);

        const change = describeChange(diff, { stopName: "stopLabel" }, snapshotManifest(snapshot));
        expect(change.added).toEqual([]);
        expect(change.removed).toEqual([]);
        expect(change.renamed).toEqual([
            { from: "stopName", to: "stopLabel", signature: "stringRefArray" },
        ]);
    });
});

describe("suggestName", () => {
    const change = (partial: Partial<ReturnType<typeof describeChange>>) => ({
        added: [],
        removed: [],
        changed: [],
        renamed: [],
        reordered: false,
        ...partial,
    });

    it("names the migration after what changed", () => {
        expect(suggestName(change({ added: [{ name: "stopBearing", signature: "x" }] }))).toBe(
            "add_stop_bearing",
        );
        expect(suggestName(change({ removed: [{ name: "oldThing", signature: "x" }] }))).toBe(
            "drop_old_thing",
        );
        expect(suggestName(change({ changed: [{ name: "stopLat", before: "a", after: "b" }] }))).toBe(
            "change_stop_lat",
        );
        expect(suggestName(change({ reordered: true }))).toBe("reorder_fields");
        expect(
            suggestName(
                change({
                    added: [
                        { name: "a", signature: "x" },
                        { name: "b", signature: "x" },
                    ],
                }),
            ),
        ).toBe("add_2_fields");
    });
});

describe("managed schema enforcement", () => {
    const bundleFor = (fields: any, entries: any[] = []) => {
        const compiled = defineSchema({ fields }).compiled;
        return defineMigrations({
            hash: compiled.hash.toString(),
            fields: compiled.layout.map(
                (entry) => [entry.name, entry.signature, entry.sectionCount] as [string, string, number],
            ),
            entries,
        });
    };

    it("accepts a schema that matches the generated bundle", () => {
        const schema = defineSchema({ fields: baseFields, migrations: bundleFor(baseFields) });
        expect(schema.version).toBe(0);
    });

    it("refuses to start when the schema drifted, naming the fields", () => {
        const bundle = bundleFor(baseFields);

        try {
            defineSchema({ fields: { ...baseFields, stopBearing: numArray(Uint16Array) }, migrations: bundle });
            throw new Error("should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(SchemaDriftError);
            expect((error as Error).message).toContain("+ stopBearing (num:Uint16Array)");
            expect((error as Error).message).toContain("bursztyn generate");
        }
    });

    it("refuses to start while a migration still has placeholders", () => {
        const fields = { ...baseFields, stopBearing: numArray(Uint16Array) };
        const bundle = bundleFor(fields, [
            { id: "0001_add_stop_bearing", defines: ["stopBearing"], pending: ["stopBearing"] },
        ]);

        try {
            defineSchema({ fields, migrations: bundle });
            throw new Error("should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(UnfinishedMigrationError);
            expect((error as Error).message).toContain("0001_add_stop_bearing");
            expect((error as Error).message).toContain("- stopBearing");
        }
    });

    it("refuses to start when nothing has been generated yet", () => {
        expect(() =>
            defineSchema({
                fields: baseFields,
                migrations: defineMigrations({ hash: "0", entries: [] }),
            }),
        ).toThrow(MissingMigrationsError);
    });

    it("derives version from the bundle and rejects a manual one", () => {
        const fields = { ...baseFields, stopBearing: numArray(Uint16Array) };
        const bundle = bundleFor(fields, [{ id: "0001_add_stop_bearing", defines: ["stopBearing"] }]);

        expect(defineSchema({ fields, migrations: bundle }).version).toBe(1);
        expect(() => defineSchema({ fields, migrations: bundle, version: 3 })).toThrow(
            /`version` is managed by the bursztyn CLI/,
        );
    });

    it("numbers bundle steps sequentially so the chain resolves", async () => {
        const fields = { ...baseFields, stopBearing: numArray(Uint16Array) };
        const schema = defineSchema({
            fields,
            migrations: bundleFor(fields, [
                {
                    id: "0001_add_stop_bearing",
                    defines: ["stopBearing"],
                    up({ previous, builders }: any) {
                        const ids = previous.get("stopId") as Uint32Array;
                        for (let i = 0; i < ids.length; i++) builders.stopBearing.push(180);
                    },
                },
            ]),
        });

        const legacy = defineSchema({ fields: baseFields }).builder();
        legacy.builders.stopId.pushString("a");
        legacy.builders.stopName.pushString("A");
        legacy.builders.stopLat.push(1);
        legacy.builders.stopRoutes.addBucket([1]);

        const { readers, report } = await schema.open(legacy.build(), { migrate: true });
        expect(report.steps[0].from).toBe(0);
        expect(report.steps[0].to).toBe(1);
        expect(Array.from(readers.stopBearing)).toEqual([180]);
    });
});
