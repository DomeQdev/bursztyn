import { describe, expect, it } from "bun:test";
import {
    bucketArray,
    createReaders,
    defineSchema,
    hashLookup,
    i32Pair,
    inspect,
    isSnapshot,
    keyedIndex,
    layoutFromManifest,
    multiBucketArray,
    numArray,
    pairIndex,
    rawBytes,
    readHeader,
    SchemaMismatchError,
    singleStringRef,
    sortedU32Index,
    stringRef,
    stringRefArray,
    stringTable,
    trigramIndex,
    u8,
    u32,
    type MultiBucketArrayReader,
} from "./index.ts";
import { createReadersFromLayout } from "./format.ts";
import type { BucketArrayReader, KeyedIndexReader, PairIndexReader } from "./fields.ts";

const schema = defineSchema({
    version: 1,
    fields: {
        strings: stringTable(),
        city: singleStringRef(),
        stopLookup: hashLookup({ verifyVia: "stopId" }),
        stopId: stringRefArray(),
        stopLat: numArray(Int32Array),
        stopRoutes: bucketArray(u32()),
        stopEntrances: multiBucketArray({ name: stringRef(), location: i32Pair() }),
        segments: pairIndex({ from: u32(), to: u8() }),
        trigrams: trigramIndex(),
        sorted: sortedU32Index(),
        keyed: keyedIndex(u32()),
        blob: rawBytes(),
    },
});

const populated = () => {
    const builder = schema.builder();

    builder.builders.city.set("warsaw");
    for (const [index, id] of ["stop-a", "stop-b", "stop-c"].entries()) {
        builder.builders.stopId.pushString(id);
        builder.builders.stopLookup.add(id, index);
    }
    builder.builders.stopLat.pushMany([52_200_000, 52_300_000, -1]);
    builder.builders.stopRoutes.addBucket([1, 2, 3]);
    builder.builders.stopRoutes.addBucket([]);
    builder.builders.stopRoutes.addBucket([9]);
    builder.builders.stopEntrances.addBucket([{ name: "Wejście A", location: [21_000_000, 52_000_000] }]);
    builder.builders.segments.add(4, 7, { from: 100, to: 200 });
    builder.builders.trigrams.addEntry(0, "Dworzec Centralny");
    builder.builders.sorted.add(77, 5);
    builder.builders.keyed.add("line-1", [3, 4]);
    builder.builders.blob.set(new Uint8Array([1, 2, 3, 4, 5]));

    return builder;
};

describe("snapshot roundtrip", () => {
    const bytes = populated().build();

    it("is recognisable and carries its schema identity", () => {
        expect(isSnapshot(bytes)).toBe(true);
        expect(isSnapshot(new Uint8Array(64))).toBe(false);

        const header = readHeader(bytes);
        expect(header.schemaHash).toBe(schema.hash);
        expect(header.schemaVersion).toBe(1);
        expect(schema.matches(bytes)).toBe(true);
    });

    it("reads every field type back", () => {
        const readers = schema.read(bytes);

        expect(readers.city).toBe("warsaw");
        expect(readers.strings.get(readers.stopId[1])).toBe("stop-b");
        expect(Array.from(readers.stopLat)).toEqual([52_200_000, 52_300_000, -1]);
        expect(readers.stopLookup.find("stop-c")).toBe(2);
        expect(readers.stopLookup.find("missing")).toBeUndefined();
        expect(Array.from(readers.stopRoutes.slice(0))).toEqual([1, 2, 3]);
        expect(readers.stopRoutes.bucketLength(1)).toBe(0);
        expect(readers.stopEntrances.get(0, 0)).toEqual({
            name: "Wejście A",
            location: [21_000_000, 52_000_000],
        });
        expect(readers.segments.find(4, 7)).toEqual({ from: 100, to: 200 });
        expect(readers.trigrams.search("Centralny")[0].idx).toBe(0);
        expect(readers.sorted.find(77)).toBe(5);
        expect(Array.from(readers.keyed.find("line-1")!)).toEqual([3, 4]);
        expect(Array.from(readers.blob)).toEqual([1, 2, 3, 4, 5]);
    });

    it("keeps typed-array views pointing into the original buffer", () => {
        const readers = schema.read(bytes);
        expect(readers.stopLat.buffer === bytes.buffer).toBe(true);
    });

    it("builds into a SharedArrayBuffer without copying", () => {
        const shared = populated().buildShared();
        expect(shared).toBeInstanceOf(SharedArrayBuffer);

        const readers = createReaders(schema.compiled, shared);
        expect(readers.city).toBe("warsaw");
        expect((readers.stopLat.buffer as ArrayBufferLike) === shared).toBe(true);
    });

    it("reports per-field byte usage", () => {
        const info = inspect(bytes);
        expect(info.schemaVersion).toBe(1);
        expect(info.fields.map((field) => field.name)).toEqual(Object.keys(schema.fields));
        expect(info.fields.reduce((sum, field) => sum + field.bytes, 0)).toBeLessThanOrEqual(
            info.totalBytes,
        );
        expect(info.fields.find((field) => field.name === "blob")!.bytes).toBe(5);
    });
});

describe("self-describing snapshots", () => {
    it("reads back without the schema, using only the embedded manifest", () => {
        const bytes = populated().build();
        const header = readHeader(bytes);
        const readers = createReadersFromLayout(layoutFromManifest(header.manifest), header);

        expect(readers.city).toBe("warsaw");
        expect(
            (readers.stopLookup as ReturnType<typeof schema.read>["stopLookup"]).find("stop-a"),
        ).toBe(0);
        expect(Array.from((readers.stopRoutes as BucketArrayReader<any>).slice(2))).toEqual([9]);
        expect((readers.keyed as KeyedIndexReader<any>).find("line-1")).toBeDefined();
        expect((readers.segments as PairIndexReader<any>).find(4, 7) as any).toEqual({
            from: 100,
            to: 200,
        });
        expect((readers.stopEntrances as MultiBucketArrayReader<any>).bucketCount).toBe(1);
    });
});

describe("schema mismatch", () => {
    it("throws with a readable diff naming the changed fields", () => {
        const other = defineSchema({
            version: 1,
            fields: {
                strings: stringTable(),
                city: singleStringRef(),
                stopLookup: hashLookup({ verifyVia: "stopId" }),
                stopId: stringRefArray(),
                stopLat: numArray(Float64Array),
                extra: numArray(Uint8Array),
            },
        });

        let error: SchemaMismatchError | undefined;
        try {
            other.read(populated().build());
        } catch (thrown) {
            error = thrown as SchemaMismatchError;
        }

        expect(error).toBeInstanceOf(SchemaMismatchError);
        expect(error!.message).toContain("stopLat: num:Int32Array -> num:Float64Array");
        expect(error!.message).toContain("+ extra");
        expect(error!.message).toContain("- stopRoutes");
        expect(error!.diff.some((entry) => entry.kind === "changed")).toBe(true);
    });
});

describe("schema validation", () => {
    it("requires exactly one string table", () => {
        expect(() => defineSchema({ fields: { a: numArray(Uint8Array) } })).toThrow(
            /exactly one stringTable/,
        );
        expect(() => defineSchema({ fields: { a: stringTable(), b: stringTable() } })).toThrow(
            /exactly one stringTable/,
        );
    });

    it("changes the hash when a field is renamed, retyped or reordered", () => {
        const base = { strings: stringTable(), a: numArray(Uint8Array), b: stringRefArray() };
        const renamed = { strings: stringTable(), c: numArray(Uint8Array), b: stringRefArray() };
        const retyped = { strings: stringTable(), a: numArray(Uint16Array), b: stringRefArray() };
        const reordered = { strings: stringTable(), b: stringRefArray(), a: numArray(Uint8Array) };

        const hash = (fields: any) => defineSchema({ fields }).hash;
        expect(hash(renamed)).not.toBe(hash(base));
        expect(hash(retyped)).not.toBe(hash(base));
        expect(hash(reordered)).not.toBe(hash(base));
        expect(hash({ ...base })).toBe(hash(base));
    });
});
