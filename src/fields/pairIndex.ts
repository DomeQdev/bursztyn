import type { AnyTypedArray, BuilderContext, Field, FieldSection, ReaderContext } from "../types.ts";
import { fmix32, hashState } from "../hash.ts";
import type { StringInterner, StringReader } from "../strings.ts";
import {
    ColumnStore,
    columnsSignature,
    readColumns,
    readColumnValue,
    type Columns,
    type ColumnSpec,
    type ColumnView,
    type ColumnReadValue,
    type ColumnWriteValue,
} from "../columns.ts";
import { HashLookupBuilder, HashLookupReader } from "./hashLookup.ts";

/**
 * Which generation of key placement a pair index uses. The number is part of
 * the signature (`pairIndex`, `pairIndex2`, `pairIndex3`), so a snapshot is
 * always probed the way it was built; only the newest is ever written.
 */
export type PairKeyLayout = 1 | 2 | 3;

const PAIR_KEY_LAYOUT: PairKeyLayout = 3;

const pairSignature = (layout: PairKeyLayout): string =>
    layout === 1 ? "pairIndex" : `pairIndex${layout}`;

/**
 * The (a, b) pair as the two halves of a table key.
 *
 * `fmix32` is murmur's avalanche and is a bijection, so distinct pairs stay
 * distinct — a hit on both halves is still an exact match, and `find` needs no
 * verification column. What it buys is the *placement*: the table probes from
 * `lo & mask`, so everything about a lookup's cost is in how `lo` is made.
 *
 * Layout 1 fed `b` in raw, and a column of structured ids — times on a minute
 * grid, keys with zeroed low bits — landed on every fourth slot and clustered.
 * Layout 2 mixed `b`, which fixed the structure but not the cardinality: the
 * slot still depended on `b` alone, so a million (route, stopSeq) pairs with
 * fifty distinct `stopSeq` values formed fifty probe chains of twenty thousand
 * entries each, and `find` walked half a chain on average. Layout 3 folds the
 * high half into the low one first, so both components spread the placement.
 * It stays a bijection: `hi` fixes `a`, and for a fixed `a` the low half is a
 * bijection of `b`. `a + 1` keeps the high half off zero so an ordinary pair
 * never hits the empty-slot sentinel.
 */
const pairKey = (a: number, b: number, layout: PairKeyLayout): void => {
    if (layout === 3) {
        const hi = fmix32((a + 1) >>> 0);
        hashState.hi = hi;
        hashState.lo = fmix32((b ^ hi) >>> 0);
    } else if (layout === 2) {
        hashState.lo = fmix32(b >>> 0);
        hashState.hi = fmix32((a + 1) >>> 0);
    } else {
        hashState.lo = b >>> 0;
        hashState.hi = (a + 1) >>> 0;
    }
};

export class PairIndexBuilder<C extends Columns> {
    private lookup = new HashLookupBuilder();
    private store: ColumnStore<C>;
    private count = 0;

    constructor(
        columns: C,
        strings: StringInterner,
        label?: string,
        private readonly layout: PairKeyLayout = PAIR_KEY_LAYOUT,
    ) {
        this.store = new ColumnStore(columns, strings, label);
    }

    add(a: number, b: number, item: { [K in keyof C]: ColumnWriteValue<C[K]> }) {
        pairKey(a, b, this.layout);
        this.lookup.addSplit(hashState.lo, hashState.hi, this.count);
        this.store.push(item);
        this.count++;
    }

    finalize() {
        return {
            lookup: this.lookup.finalize(),
            columns: this.store.finalize(),
        };
    }
}

export class PairIndexReader<C extends Columns> {
    private readonly keys: string[];
    private readonly specs: ColumnSpec[];

    constructor(
        private lookup: HashLookupReader,
        spec: C,
        /** The column views, indexed by what `findIndex` returns. */
        public readonly columns: { [K in keyof C]: ColumnView<C[K]> },
        private strings: StringReader,
        private readonly layout: PairKeyLayout = PAIR_KEY_LAYOUT,
    ) {
        this.keys = Object.keys(spec);
        this.specs = this.keys.map((key) => spec[key]);
    }

    /**
     * The row `(a, b)` was added as, or `undefined`. `columns.x[row]` then
     * reads a value without the object `find` builds per hit — which is about
     * half of what a hit costs on a large index.
     */
    findIndex(a: number, b: number): number | undefined {
        pairKey(a, b, this.layout);
        return this.lookup.findByHashSplit(hashState.lo, hashState.hi);
    }

    find(a: number, b: number): { [K in keyof C]: ColumnReadValue<C[K]> } | undefined {
        const idx = this.findIndex(a, b);
        if (idx === undefined) return undefined;

        const views = this.columns as Record<string, AnyTypedArray>;
        const result: Record<string, unknown> = {};
        for (let i = 0; i < this.keys.length; i++) {
            const key = this.keys[i];
            result[key] = readColumnValue(this.specs[i], views[key] as any, idx, this.strings);
        }
        return result as { [K in keyof C]: ColumnReadValue<C[K]> };
    }
}

class PairIndexField<C extends Columns> implements Field<PairIndexBuilder<C>, PairIndexReader<C>> {
    readonly sectionCount: number;
    constructor(
        private columns: C,
        private readonly layout: PairKeyLayout = PAIR_KEY_LAYOUT,
    ) {
        this.sectionCount = 3 + Object.keys(columns).length;
    }
    signature() {
        // Where the entries land in the table is part of the snapshot, and one
        // placement is not another — so each gets its own name rather than
        // being read back wrong under an older one.
        return `${pairSignature(this.layout)}:${columnsSignature(this.columns)}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new PairIndexBuilder(this.columns, ctx.strings, ctx.name, this.layout);
    }
    finalize(builder: PairIndexBuilder<C>): FieldSection[] {
        const { lookup, columns } = builder.finalize();
        return [
            { data: lookup.keysLow },
            { data: lookup.keysHigh },
            { data: lookup.values },
            ...columns.map((data) => ({ data })),
        ];
    }
    createReader(ctx: ReaderContext): PairIndexReader<C> {
        const lookup = new HashLookupReader(
            ctx.view(0, Uint32Array),
            ctx.view(1, Uint32Array),
            ctx.view(2, Uint32Array),
        );
        const views = readColumns(this.columns, ctx, 3);
        return new PairIndexReader(lookup, this.columns, views, ctx.strings, this.layout);
    }
}

export const pairIndex = <C extends Columns>(columns: C) => new PairIndexField(columns);

/**
 * An earlier placement — `pairIndex` keyed the table on the raw pair,
 * `pairIndex2` on the mixed halves. Reachable only through a snapshot's own
 * manifest, so an existing file stays readable and — more to the point —
 * stays migratable.
 */
export const pairIndexLegacy = <C extends Columns>(columns: C, layout: Exclude<PairKeyLayout, 3> = 1) =>
    new PairIndexField(columns, layout);
