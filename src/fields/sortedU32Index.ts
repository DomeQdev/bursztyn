import type { Field, FieldSection, ReaderContext } from "../types.ts";
import { U32Buffer } from "../growable.ts";

// Below this a comparator sort wins: three counting passes have to allocate
// their histogram and walk the data three times regardless of how little of it
// there is.
const RADIX_MIN_SIZE = 512;

/**
 * The permutation that sorts `keys` ascending, ties broken by original index —
 * exactly what `(a, b) => keys[a] - keys[b] || a - b` produces, without calling
 * into JS once per comparison.
 *
 * LSD radix over 11 + 11 + 10 bits. The keys ride along beside the indices so
 * every pass reads both sequentially instead of gathering through the
 * permutation, and a pass whose digit is constant — the top bits of a small
 * key space, which is the usual case — is skipped outright.
 */
const sortPermutationByKey = (keys: Uint32Array, size: number): Uint32Array => {
    let order = new Uint32Array(size);
    let digits = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        order[i] = i;
        digits[i] = keys[i];
    }

    let orderOut = new Uint32Array(size);
    let digitsOut = new Uint32Array(size);
    const counts = new Uint32Array(2048);

    for (let shift = 0; shift < 32; shift += 11) {
        const buckets = shift === 22 ? 1024 : 2048;
        const mask = buckets - 1;

        counts.fill(0, 0, buckets);
        for (let i = 0; i < size; i++) counts[(digits[i] >>> shift) & mask]++;
        if (counts[(digits[0] >>> shift) & mask] === size) continue;

        let running = 0;
        for (let b = 0; b < buckets; b++) {
            const count = counts[b];
            counts[b] = running;
            running += count;
        }

        for (let i = 0; i < size; i++) {
            const digit = digits[i];
            const slot = counts[(digit >>> shift) & mask]++;
            orderOut[slot] = order[i];
            digitsOut[slot] = digit;
        }

        let swap = order;
        order = orderOut;
        orderOut = swap;
        swap = digits;
        digits = digitsOut;
        digitsOut = swap;
    }

    return order;
};

export class SortedU32IndexBuilder {
    private readonly keys = new U32Buffer();
    private readonly values = new U32Buffer();

    add(key: number, value: number) {
        this.keys.push(key);
        this.values.push(value);
    }

    finalize(): { keys: Uint32Array; values: Uint32Array } {
        const keys = this.keys.view;
        const values = this.values.view;
        const size = keys.length;

        // Sorting a permutation keeps the pairs as two u32 columns throughout.
        // Sorting `{ key, value }` records meant one object per entry plus a
        // pointer array the same size again, all of it garbage afterwards.
        let order: Uint32Array;
        if (size >= RADIX_MIN_SIZE) {
            order = sortPermutationByKey(keys, size);
        } else {
            order = new Uint32Array(size);
            for (let i = 0; i < size; i++) order[i] = i;
            order.sort((a, b) => keys[a] - keys[b] || a - b);
        }

        const outKeys = new Uint32Array(size);
        const outValues = new Uint32Array(size);
        for (let i = 0; i < size; i++) {
            const from = order[i];
            outKeys[i] = keys[from];
            outValues[i] = values[from];
        }

        return { keys: outKeys, values: outValues };
    }
}

export class SortedU32IndexReader {
    constructor(
        private keys: Uint32Array,
        private values: Uint32Array,
    ) {}

    find(key: number): number | undefined {
        const keys = this.keys;
        let lo = 0;
        let hi = keys.length;

        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (keys[mid] < key) lo = mid + 1;
            else hi = mid;
        }

        if (lo < keys.length && keys[lo] === key) return this.values[lo];
        return undefined;
    }
}

class SortedU32IndexField implements Field<SortedU32IndexBuilder, SortedU32IndexReader> {
    sectionCount = 2;
    signature() {
        return "sortedU32Index";
    }
    createBuilder() {
        return new SortedU32IndexBuilder();
    }
    finalize(builder: SortedU32IndexBuilder): FieldSection[] {
        const { keys, values } = builder.finalize();
        return [{ data: keys }, { data: values }];
    }
    createReader(ctx: ReaderContext): SortedU32IndexReader {
        return new SortedU32IndexReader(ctx.view(0, Uint32Array), ctx.view(1, Uint32Array));
    }
}

export const sortedU32Index = () => new SortedU32IndexField();
