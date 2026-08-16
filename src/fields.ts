import type { BuilderContext, Field, FieldSection, ReaderContext, TypedArrayConstructor } from "./types.ts";
import type { AnyTypedArray } from "./types.ts";
import { hashChars, hashState, hashString, splitHash } from "./hash.ts";
import { NumberBuffer, U32Buffer } from "./growable.ts";
import { StringInterner, StringReader } from "./strings.ts";
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
} from "./columns.ts";

export class NumArrayBuilder {
    private readonly buffer: NumberBuffer;

    constructor(ctor: TypedArrayConstructor, label: string = ctor.name) {
        this.buffer = new NumberBuffer(ctor, label);
    }

    /** A live view of what has been pushed. Values land in the target type directly. */
    get values(): AnyTypedArray {
        return this.buffer.view;
    }

    push(v: number) {
        this.buffer.push(v);
    }

    pushMany(arr: ArrayLike<number>) {
        this.buffer.pushMany(arr);
    }

    setFrom(arr: ArrayLike<number>) {
        this.buffer.clear();
        this.buffer.pushMany(arr);
    }

    get length() {
        return this.buffer.length;
    }

    finalize(): AnyTypedArray {
        return this.buffer.view;
    }
}

class NumArrayField<TA extends TypedArrayConstructor> implements Field<NumArrayBuilder, InstanceType<TA>> {
    sectionCount = 1;
    constructor(public readonly ctor: TA) {}
    signature() {
        return `num:${this.ctor.name}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new NumArrayBuilder(this.ctor, ctx.name ?? this.ctor.name);
    }
    finalize(builder: NumArrayBuilder): FieldSection[] {
        return [{ data: builder.finalize() }];
    }
    createReader(ctx: ReaderContext): InstanceType<TA> {
        return ctx.view(0, this.ctor as any) as InstanceType<TA>;
    }
}

export const numArray = <TA extends TypedArrayConstructor>(ctor: TA) => new NumArrayField(ctor);

export class StringRefArrayBuilder {
    private readonly ids = new U32Buffer();
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
        return this.ids.view;
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

/**
 * Open-addressed table over three parallel u32 columns. Entries arrive as
 * struct-of-arrays rather than an array of `{hashLow, hashHigh, value}` records:
 * a million keys used to mean a million short-lived objects before a single byte
 * was written.
 */
const buildHashTable = (keys: { lo: Uint32Array; hi: Uint32Array; values: Uint32Array }) => {
    const size = keys.lo.length;
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

    for (let i = 0; i < size; i++) {
        let hashLow = keys.lo[i];
        const hashHigh = keys.hi[i];
        if (hashLow === 0 && hashHigh === 0) hashLow = 1;

        let slot = hashLow & mask;
        while (keysLow[slot] !== 0 || keysHigh[slot] !== 0) {
            slot = (slot + 1) & mask;
        }
        keysLow[slot] = hashLow;
        keysHigh[slot] = hashHigh;
        values[slot] = keys.values[i];
    }

    return { keysLow, keysHigh, values };
};

export class HashLookupBuilder {
    private readonly lo = new U32Buffer();
    private readonly hi = new U32Buffer();
    private readonly vals = new U32Buffer();

    add(key: string, value: number) {
        hashString(key);
        this.addSplit(hashState.lo, hashState.hi, value);
    }

    addRaw(hash: bigint, value: number) {
        splitHash(hash);
        this.addSplit(hashState.lo, hashState.hi, value);
    }

    addSplit(hashLow: number, hashHigh: number, value: number) {
        this.lo.push(hashLow);
        this.hi.push(hashHigh);
        this.vals.push(value);
    }

    finalize() {
        return buildHashTable({ lo: this.lo.view, hi: this.hi.view, values: this.vals.view });
    }
}

export class HashLookupReader {
    private match?: (idx: number, key: string) => boolean;

    constructor(
        private keysLow: Uint32Array,
        private keysHigh: Uint32Array,
        private values: Uint32Array,
    ) {}

    /** Verify a probe hit against the resolved key. */
    setVerifier(fn: (idx: number) => string) {
        this.match = (idx, key) => fn(idx) === key;
    }

    /** Verify a probe hit without materialising the stored key. */
    setKeyMatcher(fn: (idx: number, key: string) => boolean) {
        this.match = fn;
    }

    find(key: string): number | undefined {
        hashString(key);
        return this.findByHashSplit(hashState.lo, hashState.hi, key);
    }

    findRaw(hash: bigint): number | undefined {
        splitHash(hash);
        return this.findByHashSplit(hashState.lo, hashState.hi);
    }

    // The probe loop is written out here rather than shared through a callback:
    // a lookup is the hottest thing a snapshot does, and passing an `onMatch`
    // closure allocated one function per call and blocked inlining.
    findByHashSplit(hashLow: number, hashHigh: number, verifyKey?: string): number | undefined {
        const keysLow = this.keysLow;
        const capacity = keysLow.length;
        if (capacity === 0) return undefined;

        const keysHigh = this.keysHigh;
        const mask = capacity - 1;

        let lo = hashLow;
        const hi = hashHigh;
        if (lo === 0 && hi === 0) lo = 1;

        let slot = lo & mask;
        while (true) {
            const kl = keysLow[slot];
            const kh = keysHigh[slot];
            if (kl === 0 && kh === 0) return undefined;

            if (kl === lo && kh === hi) {
                const value = this.values[slot];
                if (verifyKey === undefined || this.match === undefined || this.match(value, verifyKey)) {
                    return value;
                }
            }

            slot = (slot + 1) & mask;
        }
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
            const strings = ctx.strings;
            let verifyField: Uint32Array | null = null;

            reader.setKeyMatcher((idx, key) => {
                const ids = verifyField ?? (verifyField = ctx.resolve<Uint32Array>(verifyVia));
                return strings.equals(ids[idx], key);
            });
        }

        return reader;
    }
}

export const hashLookup = (opts?: { verifyVia?: string }) => new HashLookupField(opts);

const TRIGRAM_LEN = 3;

/** How many trigrams a lowercased string of this length yields. */
const trigramCount = (len: number): number =>
    len === 0 ? 0 : len < TRIGRAM_LEN ? 1 : len - TRIGRAM_LEN + 1;

interface TrigramBucket {
    lo: number;
    hi: number;
    ids: U32Buffer;
    last: number;
}

export class TrigramIndexBuilder {
    // Keyed by the two halves of the 64-bit trigram hash. This used to be a
    // Map<bigint, Set<number>>: every trigram of every name allocated a BigInt
    // just to be hashed, and every posting list was a Set. Two numeric Map
    // levels and a packed u32 list do the same job without either.
    private readonly index = new Map<number, Map<number, TrigramBucket>>();
    private readonly buckets: TrigramBucket[] = [];
    private maxEntity = -1;
    private postings = 0;

    addEntry(entityIdx: number, name: string) {
        const lower = name.toLowerCase();
        const len = lower.length;
        const count = trigramCount(len);

        for (let t = 0; t < count; t++) {
            // Hashing the slice in place — `substring(i, i + 3)` allocated one
            // throwaway string per character of every name in the index.
            hashChars(lower, len < TRIGRAM_LEN ? 0 : t, len < TRIGRAM_LEN ? len : t + TRIGRAM_LEN);
            this.addSplit(hashState.lo, hashState.hi, entityIdx);
        }
    }

    addHash(hash: bigint, entityIdx: number) {
        splitHash(hash);
        this.addSplit(hashState.lo, hashState.hi, entityIdx);
    }

    private addSplit(hashLow: number, hashHigh: number, entityIdx: number) {
        // Same sentinel the table uses: an all-zero key marks an empty slot.
        const lo = hashLow === 0 && hashHigh === 0 ? 1 : hashLow;

        let byLo = this.index.get(hashHigh);
        if (byLo === undefined) this.index.set(hashHigh, (byLo = new Map()));

        let bucket = byLo.get(lo);
        if (bucket === undefined) {
            bucket = { lo, hi: hashHigh, ids: new U32Buffer(), last: -1 };
            byLo.set(lo, bucket);
            this.buckets.push(bucket);
        }

        // Every trigram of one name is added in one go, so a repeated trigram
        // ("ana" in "banana") always lands back-to-back in its bucket. Catching
        // it here keeps the posting list from carrying duplicates at all.
        if (bucket.last === entityIdx) return;
        bucket.last = entityIdx;
        bucket.ids.push(entityIdx);
        this.postings++;

        if (entityIdx > this.maxEntity) this.maxEntity = entityIdx;
    }

    finalize() {
        const count = this.buckets.length;
        const lo = new Uint32Array(count);
        const hi = new Uint32Array(count);
        const values = new Uint32Array(count);
        const ptr = new Uint32Array(count + 1);
        const data = new U32Buffer(this.postings);

        // The back-to-back guard above misses one case: the same entity indexed
        // twice under different names, with another entity in between. Stamping
        // catches it in O(1) per posting — but a sparse id space would make the
        // stamp array larger than the index itself, so that falls back to a Set.
        const dense = this.maxEntity >= 0 && this.maxEntity + 1 <= this.postings * 4 + 1024;
        const stamp = dense ? new Int32Array(this.maxEntity + 1).fill(-1) : null;
        const seen = dense ? null : new Set<number>();

        for (let b = 0; b < count; b++) {
            const bucket = this.buckets[b];
            lo[b] = bucket.lo;
            hi[b] = bucket.hi;
            values[b] = b;

            const ids = bucket.ids.view;
            seen?.clear();

            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                if (stamp !== null) {
                    if (stamp[id] === b) continue;
                    stamp[id] = b;
                } else if (seen!.has(id)) {
                    continue;
                } else {
                    seen!.add(id);
                }
                data.push(id);
            }

            ptr[b + 1] = data.length;
        }

        const lookup = buildHashTable({ lo, hi, values });
        return {
            keysLow: lookup.keysLow,
            keysHigh: lookup.keysHigh,
            values: lookup.values,
            ptr,
            data: data.view,
        };
    }
}

export class TrigramIndexReader {
    private scores: Uint32Array | null = null;
    private stamp: Int32Array | null = null;
    private matches: Map<number, number> | null = null;
    private generation = 0;

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
        const lower = query.toLowerCase();
        const len = lower.length;
        const trigrams = trigramCount(len);
        if (trigrams === 0) return [];

        if (this.scores === null && this.matches === null) this.prepareScratch();

        const scores = this.scores;
        const stamp = this.stamp;
        const matches = this.matches;
        const generation = this.nextGeneration();
        matches?.clear();

        const ptr = this.ptr;
        const data = this.data;
        const touched: number[] = [];
        let maxScore = 0;

        for (let t = 0; t < trigrams; t++) {
            hashChars(lower, len < TRIGRAM_LEN ? 0 : t, len < TRIGRAM_LEN ? len : t + TRIGRAM_LEN);

            const bucketIdx = this.findBucket(hashState.lo, hashState.hi);
            if (bucketIdx === -1) continue;

            const from = ptr[bucketIdx];
            const to = ptr[bucketIdx + 1];

            for (let i = from; i < to; i++) {
                const id = data[i];
                let score: number;

                if (scores !== null) {
                    if (stamp![id] !== generation) {
                        stamp![id] = generation;
                        scores[id] = 0;
                        touched.push(id);
                    }
                    score = ++scores[id];
                } else {
                    score = (matches!.get(id) ?? 0) + 1;
                    if (score === 1) touched.push(id);
                    matches!.set(id, score);
                }

                if (score > maxScore) maxScore = score;
            }
        }

        const minMatches = Math.max(1, trigrams - 1);
        const cutoff = Math.max(minMatches, maxScore * (opts.dynamicCutoffRatio ?? 0.7));
        const results: { idx: number; score: number }[] = [];

        for (let i = 0; i < touched.length; i++) {
            const idx = touched[i];
            const score = scores !== null ? scores[idx] : matches!.get(idx)!;
            if (score >= cutoff) results.push({ idx, score });
        }

        results.sort((a, b) => b.score - a.score);

        if (opts.limit !== undefined && results.length > opts.limit) {
            results.length = opts.limit;
        }

        return results;
    }

    /**
     * Scoring scratch, allocated on the first search and reused after that.
     * Tallying into a fresh `Map` per query cost a hash per posting visited;
     * indexing a typed array by entity id costs nothing. The array is only worth
     * it when ids are dense — otherwise it would dwarf the index it serves, and
     * a reused Map takes over.
     */
    private prepareScratch() {
        const data = this.data;
        let max = -1;
        for (let i = 0; i < data.length; i++) {
            if (data[i] > max) max = data[i];
        }

        if (max >= 0 && max + 1 <= data.length * 4 + 1024) {
            this.scores = new Uint32Array(max + 1);
            this.stamp = new Int32Array(max + 1);
        } else {
            this.matches = new Map();
        }
    }

    private nextGeneration(): number {
        if (this.generation === 0x7fffffff) {
            this.stamp?.fill(0);
            this.generation = 0;
        }
        return ++this.generation;
    }

    private findBucket(hashLow: number, hashHigh: number): number {
        const keysLow = this.keysLow;
        const capacity = keysLow.length;
        if (capacity === 0) return -1;

        const keysHigh = this.keysHigh;
        const mask = capacity - 1;

        let lo = hashLow;
        const hi = hashHigh;
        if (lo === 0 && hi === 0) lo = 1;

        let slot = lo & mask;
        while (true) {
            const kl = keysLow[slot];
            const kh = keysHigh[slot];
            if (kl === 0 && kh === 0) return -1;
            if (kl === lo && kh === hi) return this.values[slot];
            slot = (slot + 1) & mask;
        }
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
        const order = new Uint32Array(size);
        for (let i = 0; i < size; i++) order[i] = i;
        order.sort((a, b) => keys[a] - keys[b] || a - b);

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
    // The single column is held directly instead of through ColumnStore:
    // routing every value through `store.push({ data: value })` allocated a
    // wrapper object per item, on the path that runs once per element written.
    private readonly store: NumberBuffer | U32Buffer;
    private readonly stride: number;
    private readonly ptrBuf = new U32Buffer();

    constructor(
        private readonly spec: S,
        private readonly strings: StringInterner,
        label = "data",
    ) {
        this.store = spec.kind === "num" ? new NumberBuffer(spec.ctor, label) : new U32Buffer();
        this.stride = spec.kind === "num" ? spec.stride : 1;
        this.ptrBuf.push(0);
    }

    get ptr(): Uint32Array {
        return this.ptrBuf.view;
    }

    get values(): AnyTypedArray {
        return this.store.view;
    }

    push(value: ColumnWriteValue<S>) {
        if (this.spec.kind !== "num") {
            (this.store as U32Buffer).push(this.strings.add((value as string) ?? ""));
            return;
        }

        const store = this.store as NumberBuffer;
        if (this.stride === 1) {
            store.push(value as number);
            return;
        }

        const arr = value as ArrayLike<number>;
        store.reserve(this.stride);
        for (let s = 0; s < this.stride; s++) store.push(arr[s] ?? 0);
    }

    endBucket() {
        this.ptrBuf.push(this.store.length / this.stride);
    }

    get bucketCount(): number {
        return this.ptrBuf.length - 1;
    }

    addBucket(values: ArrayLike<ColumnWriteValue<S>>) {
        for (let i = 0; i < values.length; i++) this.push(values[i]);
        this.endBucket();
    }

    finalize() {
        return { ptr: this.ptrBuf.view, data: this.store.view };
    }
}

export class BucketArrayReader<S extends ColumnSpec> {
    private readonly stride: number;

    constructor(
        public readonly ptr: Uint32Array,
        public readonly data: ColumnView<S>,
        private readonly spec: S,
        private readonly strings: StringReader,
    ) {
        this.stride = spec.kind === "num" ? spec.stride : 1;
    }

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
        const stride = this.stride;
        const data = this.data as AnyTypedArray;
        const start = this.ptr[bucketIdx] * stride;
        const end = this.ptr[bucketIdx + 1] * stride;
        return data.subarray(start, end) as ColumnView<S>;
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
        return new BucketArrayBuilder(this.spec, ctx.strings, ctx.name ?? "data");
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
    private readonly ptrBuf = new U32Buffer();

    constructor(columns: C, strings: StringInterner, label?: string) {
        this.store = new ColumnStore(columns, strings, label);
        this.ptrBuf.push(0);
    }

    get ptr(): Uint32Array {
        return this.ptrBuf.view;
    }

    push(item: { [K in keyof C]: ColumnWriteValue<C[K]> }) {
        this.store.push(item);
    }

    endBucket() {
        this.ptrBuf.push(this.store.itemCount());
    }

    get bucketCount(): number {
        return this.ptrBuf.length - 1;
    }

    get buffers(): { readonly [K in keyof C]: AnyTypedArray } {
        return this.store.buffers;
    }

    addBucket(items: { [K in keyof C]: ColumnWriteValue<C[K]> }[]) {
        for (const item of items) this.push(item);
        this.endBucket();
    }

    finalize() {
        return {
            ptr: this.ptrBuf.view,
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
    private readonly keys: string[];
    private readonly specs: ColumnSpec[];

    constructor(private columns: C) {
        this.keys = Object.keys(columns);
        this.specs = this.keys.map((key) => columns[key]);
        this.sectionCount = 1 + this.keys.length;
    }
    signature() {
        return `multiBucketArray:${columnsSignature(this.columns)}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new MultiBucketArrayBuilder(this.columns, ctx.strings, ctx.name);
    }
    finalize(builder: MultiBucketArrayBuilder<C>): FieldSection[] {
        const { ptr, columns } = builder.finalize();
        return [{ data: ptr }, ...columns.map((data) => ({ data }))];
    }
    createReader(ctx: ReaderContext): MultiBucketArrayReader<C> {
        const ptr = ctx.view(0, Uint32Array);
        const cols = readColumns(this.columns, ctx, 1) as Record<string, AnyTypedArray>;
        const keys = this.keys;
        const specs = this.specs;
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
                const result: Record<string, unknown> = {};
                // keys/specs are resolved once when the field is built, not on
                // every read: this used to call Object.keys() per get().
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    result[key] = readColumnValue(specs[i], cols[key] as any, offset, strings);
                }
                return result as { [K in keyof C]: ColumnReadValue<C[K]> };
            },
        };
        return Object.assign(base, cols) as MultiBucketArrayReader<C>;
    }
}

export const multiBucketArray = <C extends Columns>(columns: C) => new MultiBucketArrayField(columns);

export class KeyedIndexBuilder<S extends ColumnSpec> {
    private lookup = new HashLookupBuilder();
    private buckets: BucketArrayBuilder<S>;

    constructor(spec: S, strings: StringInterner, label?: string) {
        this.buckets = new BucketArrayBuilder(spec, strings, label);
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
        return new KeyedIndexBuilder(this.spec, ctx.strings, ctx.name);
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

    constructor(columns: C, strings: StringInterner, label?: string) {
        this.store = new ColumnStore(columns, strings, label);
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
    private readonly keys: string[];
    private readonly specs: ColumnSpec[];

    constructor(
        private lookup: HashLookupReader,
        columns: C,
        private views: { [K in keyof C]: ColumnView<C[K]> },
        private strings: StringReader,
    ) {
        this.keys = Object.keys(columns);
        this.specs = this.keys.map((key) => columns[key]);
    }

    find(a: number, b: number): { [K in keyof C]: ColumnReadValue<C[K]> } | undefined {
        const idx = this.lookup.findByHashSplit(b >>> 0, (a + 1) >>> 0);
        if (idx === undefined) return undefined;

        const views = this.views as Record<string, AnyTypedArray>;
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
    constructor(private columns: C) {
        this.sectionCount = 3 + Object.keys(columns).length;
    }
    signature() {
        return `pairIndex:${columnsSignature(this.columns)}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new PairIndexBuilder(this.columns, ctx.strings, ctx.name);
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
