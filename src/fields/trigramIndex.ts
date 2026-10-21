import type { Field, FieldSection, ReaderContext } from "../types.ts";
import { hashChars, hashState, hashTrigram, splitHash } from "../hash.ts";
import { U32Buffer } from "../growable.ts";
import { buildHashTable } from "./hashLookup.ts";

const TRIGRAM_LEN = 3;

/** How many trigrams a lowercased string of this length yields. */
const trigramCount = (len: number): number =>
    len === 0 ? 0 : len < TRIGRAM_LEN ? 1 : len - TRIGRAM_LEN + 1;

// The trigram builder's slot tables: `[lo, hi, bucket + 1]` per slot, so one
// probe touches one cache line. Zero in the third word marks an empty slot.
const TRIGRAM_SLOT = 3;
const TRIGRAM_INITIAL_SLOTS = 1024;

const lowerAscii = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);

// Where a trigram's own code units land in the builder's text table. Only the
// placement — a hit is confirmed on both key words — so a cheap mix will do.
const charSlot = (keyLo: number, keyHi: number): number =>
    Math.imul(keyLo ^ Math.imul(keyHi, 0x9e3779b1), 0x85ebca6b) >>> 7;

export class TrigramIndexBuilder {
    // Trigram → bucket, open addressed over the two halves of the 64-bit
    // trigram hash. This used to be a Map<number, Map<number, bucket>> with a
    // growable list per bucket: two hash lookups and, for a new trigram, a
    // Map plus an object plus an array — for every trigram of every name. A
    // flat table and flat postings do the same job with one probe and no
    // allocation on the path that runs once per trigram.
    private slots = new Uint32Array(TRIGRAM_INITIAL_SLOTS * TRIGRAM_SLOT);
    private slotMask = TRIGRAM_INITIAL_SLOTS - 1;

    // The same mapping keyed by the trigram's code units rather than its hash:
    // `[c0 | c1 << 16, c2 | length << 16, bucket + 1]`. The snapshot is read
    // by hash, but it is built from text, and a name's trigrams are nearly all
    // ones the index has seen before — so the 64-bit hash is computed once per
    // distinct trigram, when its bucket is created, instead of once per
    // occurrence. That took about a third off indexing a million names.
    private charSlots = new Uint32Array(TRIGRAM_INITIAL_SLOTS * TRIGRAM_SLOT);
    private charMask = TRIGRAM_INITIAL_SLOTS - 1;
    private charCount = 0;

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
        // An ASCII name is lowercased one code unit at a time on its way into
        // the key, so the common case never allocates a lowered copy. Anything
        // else goes through `toLowerCase()`, which is allowed to change the
        // length (U+0130 becomes two code units), so the trigram walk is over
        // the lowered string, exactly as the reader walks its query.
        let lower = name;
        let ascii = true;
        for (let i = 0; i < name.length; i++) {
            if (name.charCodeAt(i) > 0x7f) {
                ascii = false;
                break;
            }
        }
        if (!ascii) lower = name.toLowerCase();

        const len = lower.length;
        const count = trigramCount(len);
        const width = len < TRIGRAM_LEN ? len : TRIGRAM_LEN;

        for (let t = 0; t < count; t++) {
            let c0 = lower.charCodeAt(t);
            let c1 = width > 1 ? lower.charCodeAt(t + 1) : 0;
            let c2 = width > 2 ? lower.charCodeAt(t + 2) : 0;
            if (ascii) {
                c0 = lowerAscii(c0);
                c1 = lowerAscii(c1);
                c2 = lowerAscii(c2);
            }
            this.post(this.bucketOfChars(c0, c1, c2, width), entityIdx);
        }
    }

    addHash(hash: bigint, entityIdx: number) {
        splitHash(hash);
        this.post(this.bucketOfHash(hashState.lo, hashState.hi), entityIdx);
    }

    private bucketOfChars(c0: number, c1: number, c2: number, width: number): number {
        const keyLo = (c0 | (c1 << 16)) >>> 0;
        const keyHi = (c2 | (width << 16)) >>> 0;

        const slots = this.charSlots;
        const mask = this.charMask;
        let slot = charSlot(keyLo, keyHi) & mask;

        while (true) {
            const at = slot * TRIGRAM_SLOT;
            const stored = slots[at + 2];
            if (stored === 0) break;
            if (slots[at] === keyLo && slots[at + 1] === keyHi) return stored - 1;
            slot = (slot + 1) & mask;
        }

        // First sighting: hash it the way the reader will, and remember the
        // bucket under the text key so no later occurrence pays for the hash.
        hashTrigram(c0, c1, c2, width);
        const bucket = this.bucketOfHash(hashState.lo, hashState.hi);

        const at = slot * TRIGRAM_SLOT;
        slots[at] = keyLo;
        slots[at + 1] = keyHi;
        slots[at + 2] = bucket + 1;
        if (++this.charCount * 2 > mask + 1) this.growCharSlots();

        return bucket;
    }

    private bucketOfHash(hashLow: number, hashHigh: number): number {
        // Same sentinel the table uses: an all-zero key marks an empty slot.
        const lo = hashLow === 0 && hashHigh === 0 ? 1 : hashLow;
        const hi = hashHigh;

        const slots = this.slots;
        const mask = this.slotMask;
        let slot = lo & mask;

        while (true) {
            const at = slot * TRIGRAM_SLOT;
            const stored = slots[at + 2];

            if (stored === 0) {
                const bucket = this.bucketLo.length;
                this.bucketLo.push(lo);
                this.bucketHi.push(hi);
                this.bucketLast.push(0);
                slots[at] = lo;
                slots[at + 1] = hi;
                slots[at + 2] = bucket + 1;
                if ((bucket + 1) * 2 > mask + 1) this.growSlots();
                return bucket;
            }

            if (slots[at] === lo && slots[at + 1] === hi) return stored - 1;

            slot = (slot + 1) & mask;
        }
    }

    private post(bucket: number, entityIdx: number) {
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

    private growCharSlots() {
        const capacity = (this.charMask + 1) * 2;
        const mask = capacity - 1;
        const old = this.charSlots;
        const slots = new Uint32Array(capacity * TRIGRAM_SLOT);

        for (let from = 0; from < old.length; from += TRIGRAM_SLOT) {
            const stored = old[from + 2];
            if (stored === 0) continue;
            const keyLo = old[from];
            const keyHi = old[from + 1];
            let slot = charSlot(keyLo, keyHi) & mask;
            while (slots[slot * TRIGRAM_SLOT + 2] !== 0) slot = (slot + 1) & mask;
            const at = slot * TRIGRAM_SLOT;
            slots[at] = keyLo;
            slots[at + 1] = keyHi;
            slots[at + 2] = stored;
        }

        this.charSlots = slots;
        this.charMask = mask;
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

    // One bit per entity, set while it is a candidate of the current query.
    // The lists that only score (see `search`) test this before touching
    // `dense`: 128 KB per million entities stays in L2, the 8 MB of scores
    // does not. Dense mode only; the Map path is its own membership test.
    private bits: Uint32Array | null = null;

    // The ids this query scored, so the result sweep visits only them. Kept on
    // the reader and refilled per search: a fresh array per query handed the
    // collector one more thing to reclaim on every keystroke of a type-ahead.
    private touched = new Uint32Array(0);
    private touchedCount = 0;

    // The posting-list bounds of the current query's trigrams, resolved up
    // front so the scoring passes can be ordered. Reused across searches.
    private listFrom = new Uint32Array(0);
    private listTo = new Uint32Array(0);

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
        if (trigrams === 1) return ratio > 1 ? [] : this.searchSingle(lower, len, opts.limit);

        if (this.dense === null && this.matches === null) this.prepareScratch();

        const dense = this.dense;
        const generation = this.nextGeneration();
        this.matches?.clear();

        const ptr = this.ptr;
        this.touchedCount = 0;

        // Resolve every trigram's posting list first. The cutoff below is
        // never lower than `trigrams - 1`, so a name has to appear in all the
        // lists but one — which means it appears in at least one of *any two*
        // of them. So only the first two lists admit new candidates; the rest
        // merely score the ones already admitted, and never touch an id that
        // could not qualify. On a long query over a big index most postings
        // are such ids, and admitting each cost a write to `dense` plus a
        // `touched` slot plus a visit in the result sweep. For the same
        // reason two lists the index has never seen settle the query at once.
        // The order the lists are scored in is unchanged, so ties still come
        // out in first-seen order.
        if (this.listFrom.length < trigrams) {
            this.listFrom = new Uint32Array(trigrams * 2);
            this.listTo = new Uint32Array(trigrams * 2);
        }
        const listFrom = this.listFrom;
        const listTo = this.listTo;
        let missing = 0;

        for (let t = 0; t < trigrams; t++) {
            hashChars(lower, len < TRIGRAM_LEN ? 0 : t, len < TRIGRAM_LEN ? len : t + TRIGRAM_LEN);
            const bucketIdx = this.findBucket(hashState.lo, hashState.hi);
            if (bucketIdx === -1) {
                missing++;
                listFrom[t] = 0;
                listTo[t] = 0;
            } else {
                listFrom[t] = ptr[bucketIdx];
                listTo[t] = ptr[bucketIdx + 1];
            }
        }
        if (missing >= 2) return [];

        // The scoring loops are methods of their own rather than inlined here:
        // with them inline this function grew past what JavaScriptCore will
        // take to its top tier, and every query — including the one-trigram
        // path above, which had not changed — ran slower on Bun.
        let maxScore = 0;
        for (let t = 0; t < trigrams; t++) {
            const admit = t < 2;
            if (dense !== null) {
                maxScore = admit
                    ? this.admitDense(listFrom[t], listTo[t], generation, maxScore)
                    : this.scoreDense(listFrom[t], listTo[t], maxScore);
            } else {
                maxScore = this.scoreSparse(listFrom[t], listTo[t], admit, maxScore);
            }
        }
        if (dense !== null) this.clearBits();

        const matches = this.matches;
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

    // One trigram — the first keystrokes of a type-ahead, which also hit the
    // longest posting lists — needs no scoring: every posting scores 1, ties
    // keep the list's own order, and the cutoff is 1 unless the ratio is
    // asked to exceed the best score (the caller has already returned then).
    private searchSingle(lower: string, len: number, limit: number | undefined): { idx: number; score: number }[] {
        hashChars(lower, 0, len);
        const bucketIdx = this.findBucket(hashState.lo, hashState.hi);
        if (bucketIdx === -1) return [];

        const from = this.ptr[bucketIdx];
        const total = this.ptr[bucketIdx + 1] - from;
        const take = limit !== undefined && limit < total ? Math.max(0, limit) : total;
        const data = this.data;
        const results: { idx: number; score: number }[] = new Array(take);
        for (let i = 0; i < take; i++) results[i] = { idx: data[from + i], score: 1 };
        return results;
    }

    /** Score one posting list, admitting every id in it as a candidate. */
    private admitDense(from: number, to: number, generation: number, maxScore: number): number {
        const data = this.data;
        const dense = this.dense!;
        const bits = this.bits!;

        for (let i = from; i < to; i++) {
            const id = data[i];
            const at = id * 2;
            let score: number;
            if (dense[at] !== generation) {
                dense[at] = generation;
                dense[at + 1] = score = 1;
                bits[id >>> 5] |= 1 << (id & 31);
                this.touch(id);
            } else {
                score = ++dense[at + 1];
            }
            if (score > maxScore) maxScore = score;
        }

        return maxScore;
    }

    /** Score one posting list against the candidates admitted so far. */
    private scoreDense(from: number, to: number, maxScore: number): number {
        const data = this.data;
        const dense = this.dense!;
        const bits = this.bits!;

        for (let i = from; i < to; i++) {
            const id = data[i];
            if ((bits[id >>> 5] & (1 << (id & 31))) === 0) continue;
            const score = ++dense[id * 2 + 1];
            if (score > maxScore) maxScore = score;
        }

        return maxScore;
    }

    private scoreSparse(from: number, to: number, admit: boolean, maxScore: number): number {
        const data = this.data;
        const matches = this.matches!;

        for (let i = from; i < to; i++) {
            const id = data[i];
            const current = matches.get(id);
            if (current === undefined) {
                if (!admit) continue;
                this.touch(id);
                matches.set(id, 1);
                if (maxScore < 1) maxScore = 1;
            } else {
                matches.set(id, current + 1);
                if (current + 1 > maxScore) maxScore = current + 1;
            }
        }

        return maxScore;
    }

    private clearBits() {
        const bits = this.bits!;
        const touched = this.touched;
        for (let i = 0; i < this.touchedCount; i++) {
            const id = touched[i];
            bits[id >>> 5] &= ~(1 << (id & 31));
        }
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
            this.bits = new Uint32Array((max >>> 5) + 1);
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
