import { describe, expect, it } from "bun:test";
import {
    assertNumericRange,
    BucketArrayBuilder,
    BucketArrayReader,
    HashLookupBuilder,
    HashLookupReader,
    KeyedIndexBuilder,
    KeyedIndexReader,
    PairIndexBuilder,
    PairIndexReader,
    SortedU32IndexBuilder,
    SortedU32IndexReader,
    TrigramIndexBuilder,
    TrigramIndexReader,
    stringRef,
    u32,
} from "./index.ts";
import { StringInterner, StringReader } from "./strings.ts";

const makeStringReader = (interner: StringInterner): StringReader => {
    const { offsets, data } = interner.serialize();
    return new StringReader(offsets, data);
};

const buildHashLookup = (entries: [key: string, value: number][]): HashLookupReader => {
    const builder = new HashLookupBuilder();
    for (const [key, value] of entries) {
        builder.add(key, value);
    }
    const { keysLow, keysHigh, values } = builder.finalize();
    return new HashLookupReader(keysLow, keysHigh, values);
};

describe("StringInterner", () => {
    it("assigns id 0 to the empty string", () => {
        const interner = new StringInterner();
        expect(interner.add("")).toBe(0);
        expect(interner.get(0)).toBe("");
    });

    it("dedupes repeated strings to the same id", () => {
        const interner = new StringInterner();
        const first = interner.add("Rondo ONZ");
        const second = interner.add("Rondo ONZ");
        expect(first).toBe(second);
        expect(interner.add("Dworzec")).not.toBe(first);
    });

    it("roundtrips through serialize + StringReader with UTF-8 multibyte", () => {
        const interner = new StringInterner();
        const kr = interner.add("Kraków");
        const emoji = interner.add("🚋 tram");
        const reader = makeStringReader(interner);

        expect(reader.get(0)).toBe("");
        expect(reader.get(kr)).toBe("Kraków");
        expect(reader.get(emoji)).toBe("🚋 tram");
    });

    it("returns empty string for out-of-range ids", () => {
        const interner = new StringInterner();
        interner.add("a");
        expect(makeStringReader(interner).get(999)).toBe("");
    });

    it("hydrates from a reader preserving every id", () => {
        const original = new StringInterner();
        const ids = ["Kraków", "Gdańsk", "Łódź"].map((name) => original.add(name));
        const hydrated = StringInterner.hydrate(makeStringReader(original));

        for (let i = 0; i < ids.length; i++) {
            expect(hydrated.get(ids[i])).toBe(original.get(ids[i]));
        }
        expect(hydrated.size).toBe(original.size);
        expect(hydrated.add("Kraków")).toBe(ids[0]);
    });
});

describe("assertNumericRange", () => {
    it("throws RangeError when a value overflows the ctor range", () => {
        expect(() => assertNumericRange(Uint8Array, [255, 256], "x")).toThrow(RangeError);
        expect(() => assertNumericRange(Uint8Array, [-1], "x")).toThrow(RangeError);
        expect(() => assertNumericRange(Int8Array, [128], "x")).toThrow(RangeError);
    });

    it("names the offending index and label in the message", () => {
        expect(() => assertNumericRange(Uint16Array, [0, 0, 70000], "myField")).toThrow(
            /myField: value 70000 at index 2/,
        );
    });

    it("passes for in-range values and float ctors", () => {
        expect(() => assertNumericRange(Uint8Array, [0, 128, 255], "x")).not.toThrow();
        expect(() => assertNumericRange(Float64Array, [1e300, -1e300], "x")).not.toThrow();
    });
});

describe("HashLookupReader", () => {
    it("finds every inserted key", () => {
        const entries: [string, number][] = [];
        for (let i = 0; i < 500; i++) {
            entries.push([`stop-${i}`, i * 7]);
        }
        const reader = buildHashLookup(entries);
        for (const [key, value] of entries) {
            expect(reader.find(key)).toBe(value);
        }
    });

    it("returns undefined for a missing key and for an empty table", () => {
        expect(buildHashLookup([["a", 1]]).find("nope")).toBeUndefined();
        expect(buildHashLookup([]).find("anything")).toBeUndefined();
    });

    it("stores a value of 0 without treating the slot as empty", () => {
        const reader = buildHashLookup([
            ["zero", 0],
            ["one", 1],
        ]);
        expect(reader.find("zero")).toBe(0);
        expect(reader.find("one")).toBe(1);
    });

    it("handles the all-zero hash sentinel via addRaw", () => {
        const builder = new HashLookupBuilder();
        builder.addRaw(0n, 42);
        builder.addRaw(123n, 7);
        const { keysLow, keysHigh, values } = builder.finalize();
        const reader = new HashLookupReader(keysLow, keysHigh, values);
        expect(reader.findRaw(0n)).toBe(42);
        expect(reader.findRaw(123n)).toBe(7);
    });

    it("respects the verifier", () => {
        const reject = buildHashLookup([["alpha", 10]]);
        reject.setVerifier(() => "WRONG");
        expect(reject.find("alpha")).toBeUndefined();

        const accept = buildHashLookup([["alpha", 10]]);
        accept.setVerifier(() => "alpha");
        expect(accept.find("alpha")).toBe(10);
    });
});

describe("SortedU32IndexReader", () => {
    const build = (pairs: [number, number][]): SortedU32IndexReader => {
        const builder = new SortedU32IndexBuilder();
        for (const [key, value] of pairs) {
            builder.add(key, value);
        }
        const { keys, values } = builder.finalize();
        return new SortedU32IndexReader(keys, values);
    };

    it("finds values regardless of insertion order", () => {
        const reader = build([
            [30, 300],
            [10, 100],
            [20, 200],
        ]);
        expect(reader.find(10)).toBe(100);
        expect(reader.find(30)).toBe(300);
    });

    it("returns undefined for absent keys and empty indexes", () => {
        const reader = build([
            [10, 100],
            [20, 200],
        ]);
        expect(reader.find(15)).toBeUndefined();
        expect(reader.find(999)).toBeUndefined();
        expect(build([]).find(1)).toBeUndefined();
    });
});

describe("TrigramIndexReader", () => {
    const build = (names: [number, string][]): TrigramIndexReader => {
        const builder = new TrigramIndexBuilder();
        for (const [idx, name] of names) {
            builder.addEntry(idx, name);
        }
        const { keysLow, keysHigh, values, ptr, data } = builder.finalize();
        return new TrigramIndexReader(keysLow, keysHigh, values, ptr, data);
    };

    it("returns an empty array for an empty query", () => {
        expect(build([[0, "Rondo"]]).search("")).toEqual([]);
    });

    it("finds the matching entity and excludes unrelated ones", () => {
        const results = build([
            [0, "Rondo ONZ"],
            [1, "Dworzec Centralny"],
        ]).search("Dworzec");

        expect(results.map((r) => r.idx)).toContain(1);
        expect(results.map((r) => r.idx)).not.toContain(0);
    });

    it("ranks the best match first by trigram overlap", () => {
        const results = build([
            [0, "Centrum"],
            [1, "Centralna"],
            [2, "Ogród"],
        ]).search("Centralna");

        expect(results[0].idx).toBe(1);
        for (let i = 1; i < results.length; i++) {
            expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
        }
    });

    it("truncates to the requested limit", () => {
        const reader = build([
            [0, "Aleja Jana"],
            [1, "Aleja Jana Pawla"],
            [2, "Aleja Jana Kazimierza"],
        ]);
        expect(reader.search("Aleja Jana", { limit: 1 }).length).toBe(1);
    });
});

describe("BucketArrayReader", () => {
    const build = (buckets: number[][]): BucketArrayReader<ReturnType<typeof u32>> => {
        const spec = u32();
        const builder = new BucketArrayBuilder(spec, new StringInterner());
        for (const bucket of buckets) {
            builder.addBucket(bucket);
        }
        const { ptr, data } = builder.finalize();
        return new BucketArrayReader(ptr, data as any, spec, makeStringReader(new StringInterner()));
    };

    it("exposes bucket count, ranges and lengths", () => {
        const reader = build([[1, 2, 3], [4], []]);
        expect(reader.bucketCount).toBe(3);
        expect(reader.range(0)).toEqual({ start: 0, end: 3 });
        expect(reader.bucketLength(2)).toBe(0);
    });

    it("slices a bucket and reads individual items", () => {
        const reader = build([
            [10, 20, 30],
            [40, 50],
        ]);
        expect(Array.from(reader.slice(0))).toEqual([10, 20, 30]);
        expect(reader.get(1, 1)).toBe(50);
    });

    it("resolves interned strings per bucket", () => {
        const spec = stringRef();
        const interner = new StringInterner();
        const builder = new BucketArrayBuilder(spec, interner);
        builder.addBucket(["Rondo", "Metro"]);
        builder.addBucket(["Dworzec"]);
        const { ptr, data } = builder.finalize();
        const reader = new BucketArrayReader(ptr, data as any, spec, makeStringReader(interner));

        expect(reader.get(0, 1)).toBe("Metro");
        expect(reader.get(1, 0)).toBe("Dworzec");
    });
});

describe("KeyedIndexReader", () => {
    it("returns the bucket for a known key and undefined otherwise", () => {
        const spec = u32();
        const builder = new KeyedIndexBuilder(spec, new StringInterner());
        builder.add("route-1", [10, 11, 12]);
        builder.add("route-2", [20]);
        const finalised = builder.finalize();

        const reader = new KeyedIndexReader(
            new HashLookupReader(finalised.keysLow, finalised.keysHigh, finalised.values),
            new BucketArrayReader(
                finalised.ptr,
                finalised.data as any,
                spec,
                makeStringReader(new StringInterner()),
            ),
        );

        expect(Array.from(reader.find("route-1")!)).toEqual([10, 11, 12]);
        expect(reader.find("route-3")).toBeUndefined();
    });
});

describe("PairIndexReader", () => {
    const columns = { value: u32() };

    const build = (rows: [number, number, number][]): PairIndexReader<typeof columns> => {
        const builder = new PairIndexBuilder(columns, new StringInterner());
        for (const [a, b, value] of rows) {
            builder.add(a, b, { value });
        }
        const { lookup, columns: cols } = builder.finalize();
        return new PairIndexReader(
            new HashLookupReader(lookup.keysLow, lookup.keysHigh, lookup.values),
            columns,
            { value: cols[0] as any },
            makeStringReader(new StringInterner()),
        );
    };

    it("looks up a value by its (a, b) pair", () => {
        const reader = build([
            [1, 2, 100],
            [3, 4, 200],
        ]);
        expect(reader.find(1, 2)).toEqual({ value: 100 });
        expect(reader.find(3, 4)).toEqual({ value: 200 });
    });

    it("treats the pair as ordered and supports a zero component", () => {
        expect(build([[1, 2, 100]]).find(2, 1)).toBeUndefined();
        expect(build([[0, 5, 42]]).find(0, 5)).toEqual({ value: 42 });
    });

    it("returns undefined for a missing pair", () => {
        expect(build([[1, 2, 100]]).find(9, 9)).toBeUndefined();
    });
});
