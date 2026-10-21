import { describe, expect, it } from "bun:test";
import { BucketArrayBuilder, BucketArrayReader, StringInterner, StringReader, stringRef, u32 } from "../index.ts";

const makeStringReader = (interner: StringInterner): StringReader => {
    const { offsets, data } = interner.serialize();
    return new StringReader(offsets, data);
};

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
