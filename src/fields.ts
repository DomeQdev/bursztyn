import type { BuilderContext, Field, FieldSection, ReaderContext, TypedArrayConstructor } from "./types.ts";
import type { AnyTypedArray } from "./types.ts";
import { fmix32, hashChars, hashState, hashString, splitHash } from "./hash.ts";
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

// The trigram builder's slot table: `[lo, hi, bucket + 1]` per slot, so one
// probe touches one cache line. Zero in the third word marks an empty slot.
const TRIGRAM_SLOT = 3;
const TRIGRAM_INITIAL_SLOTS = 1024;

export class TrigramIndexBuilder {
    // Trigram → bucket, open addressed over the two halves of the 64-bit
    // trigram hash. This used to be a Map<number, Map<number, bucket>> with a
    // growable list per bucket: two hash lookups and, for a new trigram, a
    // Map plus an object plus an array — for every trigram of every name. A
    // flat table and flat postings do the same job with one probe and no
    // allocation on the path that runs once per trigram.
    private slots = new Uint32Array(TRIGRAM_INITIAL_SLOTS * TRIGRAM_SLOT);
    private slotMask = TRIGRAM_INITIAL_SLOTS - 1;

    // Per bucket, in creation order — which is also its id in the index.
    private readonly bucketLo = new U32Buffer();
    private readonly bucketHi = new U32Buffer();
    /** The entity most recently posted to each bucket, plus one; 0 for none. */
    private readonly bucketLast = new U32Buffer();

    // Postings as they arrive, as (bucket, entity) pairs. `finalize` groups
    // them by bucket in one counting pass.
    private readonly postBucket = new U32Buffer();
    private readonly postEntity = new U32Buffer();
    private maxEntity = -1;

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
        const hi = hashHigh;

        const slots = this.slots;
        const mask = this.slotMask;
        let slot = lo & mask;
        let bucket: number;

        while (true) {
            const at = slot * TRIGRAM_SLOT;
            const stored = slots[at + 2];

            if (stored === 0) {
                bucket = this.bucketLo.length;
                this.bucketLo.push(lo);
                this.bucketHi.push(hi);
                this.bucketLast.push(0);
                slots[at] = lo;
                slots[at + 1] = hi;
                slots[at + 2] = bucket + 1;
                if ((bucket + 1) * 2 > mask + 1) this.growSlots();
                break;
            }

            if (slots[at] === lo && slots[at + 1] === hi) {
                bucket = stored - 1;
                break;
            }

            slot = (slot + 1) & mask;
        }

        // Every trigram of one name is added in one go, so a repeated trigram
        // ("ana" in "banana") always lands back-to-back in its bucket. Catching
        // it here keeps the posting list from carrying duplicates at all.
        if (this.bucketLast.at(bucket) === entityIdx + 1) return;
        this.bucketLast.set(bucket, entityIdx + 1);
        this.postBucket.push(bucket);
        this.postEntity.push(entityIdx);

        if (entityIdx > this.maxEntity) this.maxEntity = entityIdx;
    }

    private growSlots() {
        const capacity = (this.slotMask + 1) * 2;
        const mask = capacity - 1;
        const slots = new Uint32Array(capacity * TRIGRAM_SLOT);
        const lo = this.bucketLo.view;
        const hi = this.bucketHi.view;

        for (let b = 0; b < lo.length; b++) {
            let slot = lo[b] & mask;
            while (slots[slot * TRIGRAM_SLOT + 2] !== 0) slot = (slot + 1) & mask;
            const at = slot * TRIGRAM_SLOT;
            slots[at] = lo[b];
            slots[at + 1] = hi[b];
            slots[at + 2] = b + 1;
        }

        this.slots = slots;
        this.slotMask = mask;
    }

    finalize() {
        const count = this.bucketLo.length;
        const postBucket = this.postBucket.view;
        const postEntity = this.postEntity.view;
        const postings = postBucket.length;

        // Group the postings by bucket — a counting sort, which keeps each
        // bucket's postings in the order they arrived.
        const ptr = new Uint32Array(count + 1);
        for (let p = 0; p < postings; p++) ptr[postBucket[p] + 1]++;
        for (let b = 0; b < count; b++) ptr[b + 1] += ptr[b];

        const data = new Uint32Array(postings);
        const fill = ptr.slice(0, count);
        for (let p = 0; p < postings; p++) data[fill[postBucket[p]]++] = postEntity[p];

        // The back-to-back guard above misses one case: the same entity indexed
        // twice under different names, with another entity in between. Stamping
        // catches it in O(1) per posting — but a sparse id space would make the
        // stamp array larger than the index itself, so that falls back to a Set.
        // Duplicates are compacted out in place; `ptr` is rewritten to match.
        const dense = this.maxEntity >= 0 && this.maxEntity + 1 <= postings * 4 + 1024;
        const stamp = dense ? new Int32Array(this.maxEntity + 1).fill(-1) : null;
        const seen = dense ? null : new Set<number>();

        let out = 0;
        for (let b = 0; b < count; b++) {
            const from = ptr[b];
            const to = ptr[b + 1];
            ptr[b] = out;
            seen?.clear();

            for (let i = from; i < to; i++) {
                const id = data[i];
                if (stamp !== null) {
                    if (stamp[id] === b) continue;
                    stamp[id] = b;
                } else if (seen!.has(id)) {
                    continue;
                } else {
                    seen!.add(id);
                }
                data[out++] = id;
            }
        }
        ptr[count] = out;

        const values = new Uint32Array(count);
        for (let b = 0; b < count; b++) values[b] = b;

        const lookup = buildHashTable({ lo: this.bucketLo.view, hi: this.bucketHi.view, values });
        return {
            keysLow: lookup.keysLow,
            keysHigh: lookup.keysHigh,
            values: lookup.values,
            ptr,
            data: data.subarray(0, out),
        };
    }
}

export class TrigramIndexReader {
    // Per entity, `[generation, score]` side by side at `2 * id`. Separate
    // stamp and score arrays cost a posting two cache misses on a big index;
    // one line holds both halves of the same entry.
    private dense: Int32Array | null = null;
    private matches: Map<number, number> | null = null;
    private generation = 0;

    // The ids this query scored, so the result sweep visits only them. Kept on
    // the reader and refilled per search: a fresh array per query handed the
    // collector one more thing to reclaim on every keystroke of a type-ahead.
    private touched = new Uint32Array(0);
    private touchedCount = 0;

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

        const ratio = opts.dynamicCutoffRatio ?? 0.7;

        // One trigram — the first keystrokes of a type-ahead, which also hit
        // the longest posting lists — needs no scoring: every posting scores 1,
        // ties keep the list's own order, and the cutoff is 1 unless the ratio
        // is asked to exceed the best score.
        if (trigrams === 1) {
            if (ratio > 1) return [];
            hashChars(lower, 0, len);
            const bucketIdx = this.findBucket(hashState.lo, hashState.hi);
            if (bucketIdx === -1) return [];

            const from = this.ptr[bucketIdx];
            const total = this.ptr[bucketIdx + 1] - from;
            const take = opts.limit !== undefined && opts.limit < total ? Math.max(0, opts.limit) : total;
            const data = this.data;
            const results: { idx: number; score: number }[] = new Array(take);
            for (let i = 0; i < take; i++) results[i] = { idx: data[from + i], score: 1 };
            return results;
        }

        if (this.dense === null && this.matches === null) this.prepareScratch();

        const dense = this.dense;
        const matches = this.matches;
        const generation = this.nextGeneration();
        matches?.clear();

        const ptr = this.ptr;
        const data = this.data;
        this.touchedCount = 0;
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

                if (dense !== null) {
                    const at = id * 2;
                    if (dense[at] !== generation) {
                        dense[at] = generation;
                        dense[at + 1] = score = 1;
                        this.touch(id);
                    } else {
                        score = ++dense[at + 1];
                    }
                } else {
                    score = (matches!.get(id) ?? 0) + 1;
                    if (score === 1) this.touch(id);
                    matches!.set(id, score);
                }

                if (score > maxScore) maxScore = score;
            }
        }

        const minMatches = Math.max(1, trigrams - 1);
        const cutoff = Math.max(minMatches, maxScore * ratio);
        const lowest = Math.ceil(cutoff);
        if (lowest > maxScore) return [];

        // A score is a count of matched trigrams, so it is a small integer and
        // the ranking is a counting sort: one histogram, one scatter. This used
        // to build a `{ idx, score }` per candidate and hand the lot to a
        // comparator sort — for a two-letter prefix over a big index that was
        // tens of thousands of objects per keystroke, thrown away by `limit`
        // a moment later. Ties keep the order the ids were first touched in,
        // exactly what the stable sort produced.
        const touched = this.touched;
        const touchedCount = this.touchedCount;
        const counts = this.histogram(maxScore);

        let total = 0;
        for (let i = 0; i < touchedCount; i++) {
            const idx = touched[i];
            const score = dense !== null ? dense[idx * 2 + 1] : matches!.get(idx)!;
            if (score >= lowest) {
                counts[score]++;
                total++;
            }
        }

        // Turn counts into the start offset of each score's run, best first.
        let running = 0;
        for (let score = maxScore; score >= lowest; score--) {
            const count = counts[score];
            counts[score] = running;
            running += count;
        }

        const ordered = this.orderedScratch(total);
        for (let i = 0; i < touchedCount; i++) {
            const idx = touched[i];
            const score = dense !== null ? dense[idx * 2 + 1] : matches!.get(idx)!;
            if (score >= lowest) ordered[counts[score]++] = idx;
        }

        const take = opts.limit !== undefined && opts.limit < total ? Math.max(0, opts.limit) : total;
        const results: { idx: number; score: number }[] = new Array(take);
        let out = 0;
        let from = 0;
        for (let score = maxScore; score >= lowest && out < take; score--) {
            const to = counts[score];
            for (let p = from; p < to && out < take; p++) results[out++] = { idx: ordered[p], score };
            from = to;
        }

        return results;
    }

    private touch(id: number) {
        if (this.touchedCount === this.touched.length) {
            const grown = new Uint32Array(this.touched.length === 0 ? 64 : this.touched.length * 2);
            grown.set(this.touched);
            this.touched = grown;
        }
        this.touched[this.touchedCount++] = id;
    }

    // Both scratch arrays live on the reader for the same reason `touched`
    // does: a type-ahead calls `search` once per keystroke.
    private counts = new Uint32Array(0);
    private ordered = new Uint32Array(0);

    /** A zeroed histogram with room for scores `0..maxScore`. */
    private histogram(maxScore: number): Uint32Array {
        if (this.counts.length <= maxScore) {
            this.counts = new Uint32Array(Math.max(maxScore + 1, 16));
        } else {
            this.counts.fill(0, 0, maxScore + 1);
        }
        return this.counts;
    }

    private orderedScratch(size: number): Uint32Array {
        if (this.ordered.length < size) {
            this.ordered = new Uint32Array(Math.max(size, this.ordered.length * 2, 64));
        }
        return this.ordered;
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
            this.dense = new Int32Array((max + 1) * 2);
        } else {
            this.matches = new Map();
        }
    }

    private nextGeneration(): number {
        if (this.generation === 0x7fffffff) {
            this.dense?.fill(0);
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

        store.pushStride(value as ArrayLike<number>, this.stride);
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
        columns: C,
        private views: { [K in keyof C]: ColumnView<C[K]> },
        private strings: StringReader,
        private readonly layout: PairKeyLayout = PAIR_KEY_LAYOUT,
    ) {
        this.keys = Object.keys(columns);
        this.specs = this.keys.map((key) => columns[key]);
    }

    find(a: number, b: number): { [K in keyof C]: ColumnReadValue<C[K]> } | undefined {
        pairKey(a, b, this.layout);
        const idx = this.lookup.findByHashSplit(hashState.lo, hashState.hi);
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
