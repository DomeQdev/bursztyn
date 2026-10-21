import { describe, expect, it } from "bun:test";
import {
    BucketArrayReader,
    HashLookupReader,
    KeyedIndexBuilder,
    KeyedIndexReader,
    StringInterner,
    StringReader,
    u32,
} from "../index.ts";

const makeStringReader = (interner: StringInterner): StringReader => {
    const { offsets, data } = interner.serialize();
    return new StringReader(offsets, data);
};

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
