import type { BuilderContext, Field, FieldSection, ReaderContext, TypedArrayConstructor } from "./types.js";
import type { AnyTypedArray } from "./types.js";
import { hashState, hashString, hashToBigint, splitHash } from "./hash.js";
import { StringInterner, StringReader } from "./strings.js";
import {
    assertNumericRange,
    ColumnStore,
    columnsSignature,
    readColumns,
    readColumnValue,
    type Columns,
    type ColumnSpec,
    type ColumnView,
    type ColumnReadValue,
    type ColumnWriteValue,
} from "./columns.js";

export class NumArrayBuilder {
    public readonly values: number[] = [];
    constructor(private ctor: TypedArrayConstructor) {}
    push(v: number) {
        this.values.push(v);
    }
    pushMany(arr: ArrayLike<number>) {
        for (let i = 0; i < arr.length; i++) this.values.push(arr[i]);
    }
    setFrom(arr: ArrayLike<number>) {
        this.values.length = 0;
        this.pushMany(arr);
    }
    get length() {
        return this.values.length;
    }
    finalize(label?: string): AnyTypedArray {
        assertNumericRange(this.ctor, this.values, label ?? this.ctor.name);
        return new this.ctor(this.values) as AnyTypedArray;
    }
}

class NumArrayField<TA extends TypedArrayConstructor> implements Field<NumArrayBuilder, InstanceType<TA>> {
    sectionCount = 1;
    constructor(public readonly ctor: TA) {}
    signature() {
        return `num:${this.ctor.name}`;
    }
    createBuilder() {
        return new NumArrayBuilder(this.ctor);
    }
    finalize(builder: NumArrayBuilder, name?: string): FieldSection[] {
        return [{ data: builder.finalize(name) }];
    }
    createReader(ctx: ReaderContext): InstanceType<TA> {
        return ctx.view(0, this.ctor as any) as InstanceType<TA>;
    }
}

export const numArray = <TA extends TypedArrayConstructor>(ctor: TA) => new NumArrayField(ctor);

export class StringRefArrayBuilder {
    private ids: number[] = [];
    constructor(private strings: StringInterner) {}
    pushString(s: string) {
        this.ids.push(this.strings.add(s));
    }
    pushId(id: number) {
        this.ids.push(id);
    }
    get length() {
        return this.ids.length;
    }
    finalize(): Uint32Array {
        return new Uint32Array(this.ids);
    }
}

class StringRefArrayField implements Field<StringRefArrayBuilder, Uint32Array> {
    sectionCount = 1;
    signature() {
        return "stringRefArray";
    }
    createBuilder(ctx: BuilderContext) {
        return new StringRefArrayBuilder(ctx.strings);
    }
    finalize(builder: StringRefArrayBuilder): FieldSection[] {
        return [{ data: builder.finalize() }];
    }
    createReader(ctx: ReaderContext): Uint32Array {
        return ctx.view(0, Uint32Array);
    }
}

export const stringRefArray = () => new StringRefArrayField();

export class SingleStringRefBuilder {
    public id = 0;
    constructor(private strings: StringInterner) {}
    set(value: string) {
        this.id = this.strings.add(value);
    }
}

class SingleStringRefField implements Field<SingleStringRefBuilder, string> {
    sectionCount = 1;
    signature() {
        return "singleStringRef";
    }
    createBuilder(ctx: BuilderContext) {
        return new SingleStringRefBuilder(ctx.strings);
    }
    finalize(b: SingleStringRefBuilder): FieldSection[] {
        return [{ data: new Uint32Array([b.id]) }];
    }
    createReader(ctx: ReaderContext): string {
        const arr = ctx.view(0, Uint32Array);
        return ctx.strings.get(arr[0] ?? 0);
    }
}

export const singleStringRef = () => new SingleStringRefField();

const buildHashTable = (entries: { hashLow: number; hashHigh: number; value: number }[]) => {
    const size = entries.length;
    if (size === 0) {
        return {
            keysLow: new Uint32Array(0),
            keysHigh: new Uint32Array(0),
            values: new Uint32Array(0),
        };
    }

    const capacity = 1 << (32 - Math.clz32(Math.ceil(size * 1.5)));
    const mask = capacity - 1;
    const keysLow = new Uint32Array(capacity);
    const keysHigh = new Uint32Array(capacity);
    const values = new Uint32Array(capacity);

    for (let i = 0; i < entries.length; i++) {
        let { hashLow, hashHigh, value } = entries[i];
        if (hashLow === 0 && hashHigh === 0) hashLow = 1;

        let slot = hashLow & mask;
        while (keysLow[slot] !== 0 || keysHigh[slot] !== 0) {
            slot = (slot + 1) & mask;
        }
        keysLow[slot] = hashLow;
        keysHigh[slot] = hashHigh;
        values[slot] = value;
    }

    return { keysLow, keysHigh, values };
};

const probeTable = (
    keysLow: Uint32Array,
    keysHigh: Uint32Array,
    hashLow: number,
    hashHigh: number,
    onMatch: (slot: number) => boolean,
): number => {
    const cap = keysLow.length;
    if (cap === 0) return -1;
    const mask = cap - 1;
    if (hashLow === 0 && hashHigh === 0) hashLow = 1;

    let slot = hashLow & mask;
    while (true) {
        const kl = keysLow[slot];
        const kh = keysHigh[slot];
        if (kl === 0 && kh === 0) return -1;
        if (kl === hashLow && kh === hashHigh) {
            if (onMatch(slot)) return slot;
        }
        slot = (slot + 1) & mask;
    }
};

export class HashLookupBuilder {
    private entries: { hashLow: number; hashHigh: number; value: number }[] = [];

    add(key: string, value: number) {
        hashString(key);
        this.entries.push({ hashLow: hashState.lo, hashHigh: hashState.hi, value });
    }

    addRaw(hash: bigint, value: number) {
        splitHash(hash);
        this.entries.push({ hashLow: hashState.lo, hashHigh: hashState.hi, value });
    }

    addSplit(hashLow: number, hashHigh: number, value: number) {
        this.entries.push({ hashLow, hashHigh, value });
    }

    finalize() {
        return buildHashTable(this.entries);
    }
}

export class HashLookupReader {
    private verifier?: (idx: number) => string;

    constructor(
        private keysLow: Uint32Array,
        private keysHigh: Uint32Array,
        private values: Uint32Array,
    ) {}

    setVerifier(fn: (idx: number) => string) {
        this.verifier = fn;
    }

    find(key: string): number | undefined {
        hashString(key);
        return this.findByHashSplit(hashState.lo, hashState.hi, key);
    }

    findRaw(hash: bigint): number | undefined {
        splitHash(hash);
        return this.findByHashSplit(hashState.lo, hashState.hi);
    }

    findByHashSplit(hashLow: number, hashHigh: number, verifyKey?: string): number | undefined {
        let result: number | undefined;

        probeTable(this.keysLow, this.keysHigh, hashLow, hashHigh, (slot) => {
            const value = this.values[slot];
            if (verifyKey !== undefined && this.verifier) {
                if (this.verifier(value) !== verifyKey) return false;
            }

            result = value;
            return true;
        });

        return result;
    }
}

class HashLookupField implements Field<HashLookupBuilder, HashLookupReader> {
    sectionCount = 3;
    constructor(private opts: { verifyVia?: string } = {}) {}
    signature() {
        return `hashLookup:${this.opts.verifyVia ?? ""}`;
    }
    createBuilder() {
        return new HashLookupBuilder();
    }
    finalize(builder: HashLookupBuilder): FieldSection[] {
        const { keysLow, keysHigh, values } = builder.finalize();
        return [{ data: keysLow }, { data: keysHigh }, { data: values }];
    }
    createReader(ctx: ReaderContext): HashLookupReader {
        const reader = new HashLookupReader(
            ctx.view(0, Uint32Array),
            ctx.view(1, Uint32Array),
            ctx.view(2, Uint32Array),
        );

        if (this.opts.verifyVia) {
            const verifyVia = this.opts.verifyVia;
            let verifyField: Uint32Array | null = null;

            reader.setVerifier((idx) => {
                if (verifyField === null) verifyField = ctx.resolve<Uint32Array>(verifyVia);
                return ctx.strings.get(verifyField[idx]);
            });
        }

        return reader;
    }
}

export const hashLookup = (opts?: { verifyVia?: string }) => new HashLookupField(opts);

const TRIGRAM_LEN = 3;

const collectTrigrams = (text: string): string[] => {
    const lower = text.toLowerCase();
    const out: string[] = [];

    if (lower.length < TRIGRAM_LEN) {
        if (lower.length > 0) out.push(lower);
        return out;
    }

    for (let i = 0; i + TRIGRAM_LEN <= lower.length; i++) {
        out.push(lower.substring(i, i + TRIGRAM_LEN));
    }

    return out;
};

export class TrigramIndexBuilder {
    private buckets = new Map<bigint, Set<number>>();

    addEntry(entityIdx: number, name: string) {
        for (const trigram of collectTrigrams(name)) {
            hashString(trigram);
            const hash = hashToBigint() || 1n;
            let set = this.buckets.get(hash);
            if (!set) this.buckets.set(hash, (set = new Set()));
            set.add(entityIdx);
        }
    }

    addHash(hash: bigint, entityIdx: number) {
        const h = hash || 1n;
        let set = this.buckets.get(h);
        if (!set) this.buckets.set(h, (set = new Set()));
        set.add(entityIdx);
    }

    finalize() {
        const lookupEntries: { hashLow: number; hashHigh: number; value: number }[] = [];
        const ptr: number[] = [0];
        const data: number[] = [];

        for (const [hash, ids] of this.buckets) {
            splitHash(hash);
            lookupEntries.push({ hashLow: hashState.lo, hashHigh: hashState.hi, value: ptr.length - 1 });
            for (const id of ids) data.push(id);
            ptr.push(data.length);
        }

        const lookup = buildHashTable(lookupEntries);
        return {
            keysLow: lookup.keysLow,
            keysHigh: lookup.keysHigh,
            values: lookup.values,
            ptr: new Uint32Array(ptr),
            data: new Uint32Array(data),
        };
    }
}

export class TrigramIndexReader {
    constructor(
        private keysLow: Uint32Array,
        private keysHigh: Uint32Array,
        private values: Uint32Array,
        private ptr: Uint32Array,
        private data: Uint32Array,
    ) {}

    search(
        query: string,
        opts: { dynamicCutoffRatio?: number; limit?: number } = {},
    ): { idx: number; score: number }[] {
        const cutoffRatio = opts.dynamicCutoffRatio ?? 0.7;
        const trigrams = collectTrigrams(query);
        if (trigrams.length === 0) return [];

        const matches = new Map<number, number>();
        let maxScore = 0;

        for (const trigram of trigrams) {
            hashString(trigram);
            const bucketIdx = this.findBucket(hashState.lo, hashState.hi);
            if (bucketIdx === -1) continue;

            const start = this.ptr[bucketIdx];
            const end = this.ptr[bucketIdx + 1];

            for (let i = start; i < end; i++) {
                const id = this.data[i];
                const count = (matches.get(id) ?? 0) + 1;
                if (count > maxScore) maxScore = count;

                matches.set(id, count);
            }
        }

        const minMatches = Math.max(1, trigrams.length - 1);
        const cutoff = Math.max(minMatches, maxScore * cutoffRatio);

        const results: { idx: number; score: number }[] = [];

        for (const [idx, score] of matches) {
            if (score >= cutoff) results.push({ idx, score });
        }

        results.sort((a, b) => b.score - a.score);

        if (opts.limit !== undefined && results.length > opts.limit) {
            results.length = opts.limit;
        }

        return results;
    }

    private findBucket(hashLow: number, hashHigh: number): number {
        let result = -1;

        probeTable(this.keysLow, this.keysHigh, hashLow, hashHigh, (slot) => {
            result = this.values[slot];
            return true;
        });

        return result;
    }
}

class TrigramIndexField implements Field<TrigramIndexBuilder, TrigramIndexReader> {
    sectionCount = 5;
    signature() {
        return "trigramIndex";
    }
    createBuilder() {
        return new TrigramIndexBuilder();
    }
    finalize(builder: TrigramIndexBuilder): FieldSection[] {
        const { keysLow, keysHigh, values, ptr, data } = builder.finalize();
        return [{ data: keysLow }, { data: keysHigh }, { data: values }, { data: ptr }, { data: data }];
    }
    createReader(ctx: ReaderContext): TrigramIndexReader {
        return new TrigramIndexReader(
            ctx.view(0, Uint32Array),
            ctx.view(1, Uint32Array),
            ctx.view(2, Uint32Array),
            ctx.view(3, Uint32Array),
            ctx.view(4, Uint32Array),
        );
    }
}

export const trigramIndex = () => new TrigramIndexField();

export class SortedU32IndexBuilder {
    private pairs: { key: number; value: number }[] = [];
    add(key: number, value: number) {
        this.pairs.push({ key, value });
    }
    finalize(): { keys: Uint32Array; values: Uint32Array } {
        this.pairs.sort((a, b) => a.key - b.key);
        const keys = new Uint32Array(this.pairs.length);
        const values = new Uint32Array(this.pairs.length);

        for (let i = 0; i < this.pairs.length; i++) {
            keys[i] = this.pairs[i].key;
            values[i] = this.pairs[i].value;
        }

        return { keys, values };
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

export class RawBytesBuilder {
    public data: Uint8Array = new Uint8Array(0);
    set(data: Uint8Array) {
        this.data = data;
    }
}

class RawBytesField implements Field<RawBytesBuilder, Uint8Array> {
    sectionCount = 1;
    signature() {
        return "rawBytes";
    }
    createBuilder() {
        return new RawBytesBuilder();
    }
    finalize(builder: RawBytesBuilder): FieldSection[] {
        return [{ data: builder.data }];
    }
    createReader(ctx: ReaderContext): Uint8Array {
        return ctx.sections[0];
    }
}

export const rawBytes = () => new RawBytesField();

export class BucketArrayBuilder<S extends ColumnSpec> {
    private store: ColumnStore<{ data: S }>;
    public readonly ptr: number[] = [0];

    constructor(spec: S, strings: StringInterner) {
        this.store = new ColumnStore({ data: spec } as { data: S }, strings);
    }

    get values(): number[] {
        return (this.store.buffers as any).data;
    }

    push(value: ColumnWriteValue<S>) {
        this.store.push({ data: value } as any);
    }

    endBucket() {
        this.ptr.push(this.store.itemCount());
    }

    get bucketCount(): number {
        return this.ptr.length - 1;
    }

    addBucket(values: ArrayLike<ColumnWriteValue<S>>) {
        for (let i = 0; i < values.length; i++) this.push(values[i]);
        this.endBucket();
    }

    finalize() {
        const [data] = this.store.finalize();
        return { ptr: new Uint32Array(this.ptr), data };
    }
}

export class BucketArrayReader<S extends ColumnSpec> {
    constructor(
        public readonly ptr: Uint32Array,
        public readonly data: ColumnView<S>,
        private readonly spec: S,
        private readonly strings: StringReader,
    ) {}

    get bucketCount(): number {
        return this.ptr.length - 1;
    }

    range(bucketIdx: number): { start: number; end: number } {
        return { start: this.ptr[bucketIdx], end: this.ptr[bucketIdx + 1] };
    }

    bucketLength(bucketIdx: number): number {
        return this.ptr[bucketIdx + 1] - this.ptr[bucketIdx];
    }

    slice(bucketIdx: number): ColumnView<S> {
        const start = this.ptr[bucketIdx];
        const end = this.ptr[bucketIdx + 1];

        if (this.spec.kind === "num" && this.spec.stride !== 1) {
            return (this.data as any).subarray(start * this.spec.stride, end * this.spec.stride);
        }

        return (this.data as any).subarray(start, end);
    }

    get(bucketIdx: number, itemIdx: number): ColumnReadValue<S> {
        const offset = this.ptr[bucketIdx] + itemIdx;
        return readColumnValue(this.spec, this.data, offset, this.strings);
    }
}

class BucketArrayField<S extends ColumnSpec> implements Field<BucketArrayBuilder<S>, BucketArrayReader<S>> {
    sectionCount = 2;
    constructor(private spec: S) {}
    signature() {
        return `bucketArray:${this.spec.tag}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new BucketArrayBuilder(this.spec, ctx.strings);
    }
    finalize(builder: BucketArrayBuilder<S>): FieldSection[] {
        const { ptr, data } = builder.finalize();
        return [{ data: ptr }, { data }];
    }
    createReader(ctx: ReaderContext): BucketArrayReader<S> {
        const ptr = ctx.view(0, Uint32Array);
        const data =
            this.spec.kind === "num"
                ? (ctx.view(1, this.spec.ctor as any) as ColumnView<S>)
                : (ctx.view(1, Uint32Array) as ColumnView<S>);
        return new BucketArrayReader(ptr, data, this.spec, ctx.strings);
    }
}

export const bucketArray = <S extends ColumnSpec>(spec: S) => new BucketArrayField(spec);

export class MultiBucketArrayBuilder<C extends Columns> {
    private store: ColumnStore<C>;
    public readonly ptr: number[] = [0];

    constructor(columns: C, strings: StringInterner) {
        this.store = new ColumnStore(columns, strings);
    }

    push(item: { [K in keyof C]: ColumnWriteValue<C[K]> }) {
        this.store.push(item);
    }

    endBucket() {
        this.ptr.push(this.store.itemCount());
    }

    get bucketCount(): number {
        return this.ptr.length - 1;
    }

    get buffers(): { readonly [K in keyof C]: number[] } {
        return this.store.buffers as { readonly [K in keyof C]: number[] };
    }

    addBucket(items: { [K in keyof C]: ColumnWriteValue<C[K]> }[]) {
        for (const item of items) this.push(item);
        this.endBucket();
    }

    finalize() {
        return {
            ptr: new Uint32Array(this.ptr),
            columns: this.store.finalize(),
        };
    }
}

export type MultiBucketArrayReader<C extends Columns> = MultiBucketBase<C> & {
    readonly [K in keyof C]: ColumnView<C[K]>;
};

interface MultiBucketBase<C extends Columns> {
    readonly ptr: Uint32Array;
    readonly bucketCount: number;
    range(bucketIdx: number): { start: number; end: number };
    bucketLength(bucketIdx: number): number;
    get(bucketIdx: number, itemIdx: number): { [K in keyof C]: ColumnReadValue<C[K]> };
}

class MultiBucketArrayField<C extends Columns> implements Field<
    MultiBucketArrayBuilder<C>,
    MultiBucketArrayReader<C>
> {
    readonly sectionCount: number;
    constructor(private columns: C) {
        this.sectionCount = 1 + Object.keys(columns).length;
    }
    signature() {
        return `multiBucketArray:${columnsSignature(this.columns)}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new MultiBucketArrayBuilder(this.columns, ctx.strings);
    }
    finalize(builder: MultiBucketArrayBuilder<C>): FieldSection[] {
        const { ptr, columns } = builder.finalize();
        return [{ data: ptr }, ...columns.map((data) => ({ data }))];
    }
    createReader(ctx: ReaderContext): MultiBucketArrayReader<C> {
        const ptr = ctx.view(0, Uint32Array);
        const cols = readColumns(this.columns, ctx, 1);
        const columns = this.columns;
        const strings = ctx.strings;

        const base: MultiBucketBase<C> = {
            ptr,
            get bucketCount() {
                return ptr.length - 1;
            },
            range(bucketIdx) {
                return { start: ptr[bucketIdx], end: ptr[bucketIdx + 1] };
            },
            bucketLength(bucketIdx) {
                return ptr[bucketIdx + 1] - ptr[bucketIdx];
            },
            get(bucketIdx, itemIdx) {
                const offset = ptr[bucketIdx] + itemIdx;
                const result: any = {};
                for (const key of Object.keys(columns)) {
                    const spec = columns[key];
                    result[key] = readColumnValue(spec, (cols as any)[key], offset, strings);
                }
                return result;
            },
        };
        return Object.assign(base, cols) as MultiBucketArrayReader<C>;
    }
}

export const multiBucketArray = <C extends Columns>(columns: C) => new MultiBucketArrayField(columns);

export class KeyedIndexBuilder<S extends ColumnSpec> {
    private lookup = new HashLookupBuilder();
    private buckets: BucketArrayBuilder<S>;

    constructor(spec: S, strings: StringInterner) {
        this.buckets = new BucketArrayBuilder(spec, strings);
    }

    add(key: string, values: ArrayLike<ColumnWriteValue<S>>) {
        this.lookup.add(key, this.buckets.bucketCount);
        for (let i = 0; i < values.length; i++) this.buckets.push(values[i]);
        this.buckets.endBucket();
    }

    finalize() {
        const lk = this.lookup.finalize();
        const bk = this.buckets.finalize();
        return { ...lk, ptr: bk.ptr, data: bk.data };
    }
}

export class KeyedIndexReader<S extends ColumnSpec> {
    constructor(
        private lookup: HashLookupReader,
        private buckets: BucketArrayReader<S>,
    ) {}

    find(key: string): ColumnView<S> | undefined {
        const bucketIdx = this.lookup.find(key);
        if (bucketIdx === undefined) return undefined;
        return this.buckets.slice(bucketIdx);
    }
}

class KeyedIndexField<S extends ColumnSpec> implements Field<KeyedIndexBuilder<S>, KeyedIndexReader<S>> {
    sectionCount = 5;
    constructor(private spec: S) {}
    signature() {
        return `keyedIndex:${this.spec.tag}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new KeyedIndexBuilder(this.spec, ctx.strings);
    }
    finalize(builder: KeyedIndexBuilder<S>): FieldSection[] {
        const finalised = builder.finalize();
        return [
            { data: finalised.keysLow },
            { data: finalised.keysHigh },
            { data: finalised.values },
            { data: finalised.ptr },
            { data: finalised.data },
        ];
    }
    createReader(ctx: ReaderContext): KeyedIndexReader<S> {
        const lookup = new HashLookupReader(
            ctx.view(0, Uint32Array),
            ctx.view(1, Uint32Array),
            ctx.view(2, Uint32Array),
        );
        const ptr = ctx.view(3, Uint32Array);
        const data =
            this.spec.kind === "num"
                ? (ctx.view(4, this.spec.ctor as any) as ColumnView<S>)
                : (ctx.view(4, Uint32Array) as ColumnView<S>);
        const buckets = new BucketArrayReader(ptr, data, this.spec, ctx.strings);
        return new KeyedIndexReader(lookup, buckets);
    }
}

export const keyedIndex = <S extends ColumnSpec>(spec: S) => new KeyedIndexField(spec);

export class PairIndexBuilder<C extends Columns> {
    private lookup = new HashLookupBuilder();
    private store: ColumnStore<C>;
    private count = 0;

    constructor(columns: C, strings: StringInterner) {
        this.store = new ColumnStore(columns, strings);
    }

    add(a: number, b: number, item: { [K in keyof C]: ColumnWriteValue<C[K]> }) {
        this.lookup.addSplit(b >>> 0, (a + 1) >>> 0, this.count);
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
    constructor(
        private lookup: HashLookupReader,
        private columns: C,
        private views: { [K in keyof C]: ColumnView<C[K]> },
        private strings: StringReader,
    ) {}

    find(a: number, b: number): { [K in keyof C]: ColumnReadValue<C[K]> } | undefined {
        const idx = this.lookup.findByHashSplit(b >>> 0, (a + 1) >>> 0);
        if (idx === undefined) return undefined;

        const result: any = {};
        for (const key of Object.keys(this.columns)) {
            const spec = this.columns[key];
            result[key] = readColumnValue(spec, (this.views as any)[key], idx, this.strings);
        }
        return result;
    }
}

class PairIndexField<C extends Columns> implements Field<PairIndexBuilder<C>, PairIndexReader<C>> {
    readonly sectionCount: number;
    constructor(private columns: C) {
        this.sectionCount = 3 + Object.keys(columns).length;
    }
    signature() {
        return `pairIndex:${columnsSignature(this.columns)}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new PairIndexBuilder(this.columns, ctx.strings);
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
        return new PairIndexReader(lookup, this.columns, views, ctx.strings);
    }
}

export const pairIndex = <C extends Columns>(columns: C) => new PairIndexField(columns);
