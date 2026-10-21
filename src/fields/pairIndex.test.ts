import { describe, expect, it } from "bun:test";
import {
    fieldFromSignature,
    HashLookupReader,
    PairIndexBuilder,
    PairIndexReader,
    pairIndex,
    StringInterner,
    StringReader,
    u32,
} from "../index.ts";

const makeStringReader = (interner: StringInterner): StringReader => {
    const { offsets, data } = interner.serialize();
    return new StringReader(offsets, data);
};

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

    it("finds every pair when one component has very few distinct values", () => {
        const rows: [number, number, number][] = [];
        for (let i = 0; i < 5000; i++) rows.push([i, i % 7, i * 3]);
        const reader = build(rows);
        for (const [a, b, value] of rows) expect(reader.find(a, b)).toEqual({ value });
        expect(reader.find(5000, 0)).toBeUndefined();
        expect(reader.find(0, 7)).toBeUndefined();
    });

    it("exposes the row index and the raw columns for allocation-free reads", () => {
        const reader = build([
            [1, 2, 100],
            [3, 4, 200],
        ]);
        const row = reader.findIndex(3, 4)!;
        expect(reader.columns.value[row]).toBe(200);
        expect(reader.columns.value).toBeInstanceOf(Uint32Array);
        expect(reader.findIndex(4, 3)).toBeUndefined();
    });

    it("keeps the earlier key placements readable through their own signatures", () => {
        for (const layout of [1, 2, 3] as const) {
            const builder = new PairIndexBuilder(columns, new StringInterner(), undefined, layout);
            builder.add(4, 7, { value: 100 });
            builder.add(0xffffffff, 0, { value: 200 });
            const { lookup, columns: cols } = builder.finalize();
            const reader = new PairIndexReader(
                new HashLookupReader(lookup.keysLow, lookup.keysHigh, lookup.values),
                columns,
                { value: cols[0] as any },
                makeStringReader(new StringInterner()),
                layout,
            );
            expect(reader.find(4, 7)).toEqual({ value: 100 });
            expect(reader.find(0xffffffff, 0)).toEqual({ value: 200 });
            expect(reader.find(7, 4)).toBeUndefined();
        }

        expect(pairIndex(columns).signature()).toBe("pairIndex3:value=Uint32Array:1");
        expect(fieldFromSignature("pairIndex2:value=Uint32Array:1").signature()).toBe(
            "pairIndex2:value=Uint32Array:1",
        );
        expect(fieldFromSignature("pairIndex:value=Uint32Array:1").signature()).toBe(
            "pairIndex:value=Uint32Array:1",
        );
    });
});
