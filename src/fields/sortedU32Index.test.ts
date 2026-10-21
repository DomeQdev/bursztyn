import { describe, expect, it } from "bun:test";
import { SortedU32IndexBuilder, SortedU32IndexReader } from "../index.ts";

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
