import type { BuilderContext, Field, FieldSection, ReaderContext } from "./types.ts";

const HAS_BUFFER = typeof Buffer !== "undefined";
const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

// FNV-1a over UTF-8 bytes. This one never reaches disk — it only places entries
// in the interner's in-memory dedupe index — so it is free to be whatever is
// cheapest, and a probe hit is always verified with `equals` before it counts.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const hashUtf8Bytes = (bytes: Uint8Array, start: number, end: number): number => {
    let h = FNV_OFFSET;
    for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i], FNV_PRIME);
    return h >>> 0;
};

/**
 * The same hash over the UTF-8 encoding of `s`, without encoding it. Feeding
 * the bytes out of `charCodeAt` keeps `add()` from allocating a scratch buffer
 * per call. A disagreement with the byte version would cost a missed dedupe and
 * nothing else, since `equals` decides every hit.
 */
const hashUtf8OfString = (s: string): number => {
    let h = FNV_OFFSET;
    const length = s.length;

    for (let i = 0; i < length; i++) {
        const c = s.charCodeAt(i);

        if (c < 0x80) {
            h = Math.imul(h ^ c, FNV_PRIME);
            continue;
        }

        if (c < 0x800) {
            h = Math.imul(h ^ (0xc0 | (c >> 6)), FNV_PRIME);
            h = Math.imul(h ^ (0x80 | (c & 0x3f)), FNV_PRIME);
            continue;
        }

        if (c >= 0xd800 && c <= 0xdbff && i + 1 < length) {
            const low = s.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                const point = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
                i++;
                h = Math.imul(h ^ (0xf0 | (point >> 18)), FNV_PRIME);
                h = Math.imul(h ^ (0x80 | ((point >> 12) & 0x3f)), FNV_PRIME);
                h = Math.imul(h ^ (0x80 | ((point >> 6) & 0x3f)), FNV_PRIME);
                h = Math.imul(h ^ (0x80 | (point & 0x3f)), FNV_PRIME);
                continue;
            }
        }

        if (c >= 0xd800 && c <= 0xdfff) {
            // What TextEncoder emits for an unpaired surrogate: U+FFFD.
            h = Math.imul(h ^ 0xef, FNV_PRIME);
            h = Math.imul(h ^ 0xbf, FNV_PRIME);
            h = Math.imul(h ^ 0xbd, FNV_PRIME);
            continue;
        }

        h = Math.imul(h ^ (0xe0 | (c >> 12)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | ((c >> 6) & 0x3f)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | (c & 0x3f)), FNV_PRIME);
    }

    return h >>> 0;
};

/** How many base reads it takes before the interner memoises its base table. */
const BASE_READS_BEFORE_CACHING = 32;

/**
 * The interner behind every string a snapshot holds.
 *
 * Built from scratch it is a plain `Map` plus a list. Hydrated from an existing
 * snapshot it keeps that snapshot's table as its base and *never decodes it*:
 * ids below `baseCount` resolve through the reader, dedupe goes through a byte
 * level index built on the first `add()`, and a migration that adds no strings
 * re-emits the original two sections untouched.
 */
export class StringInterner {
    /** Strings added on top of the base — ids `baseCount + i`. */
    private list: string[];
    /** Lazily built, and only ever holds strings this interner was asked about. */
    private own: Map<string, number> | null = null;
    private readonly base: StringReader | null;
    private readonly baseCount: number;
    private baseReads = 0;

    constructor(base?: StringReader) {
        // A table holding nothing but the empty string is no base at all.
        if (base !== undefined && base.count > 1) {
            this.base = base;
            this.baseCount = base.count;
            this.list = [];
        } else {
            this.base = null;
            this.baseCount = 0;
            this.list = [""];
        }
    }

    /**
     * Adopt a snapshot's table wholesale. Ids stay stable, so every carried
     * `stringRefArray` keeps resolving.
     */
    static hydrate(reader: StringReader): StringInterner {
        return new StringInterner(reader);
    }

    add(str: string = ""): number {
        if (str.length === 0) return 0;

        const own = this.own ?? (this.own = new Map());
        const existing = own.get(str);
        if (existing !== undefined) return existing;

        if (this.base !== null) {
            const inBase = this.base.idOf(str);
            if (inBase > 0) {
                own.set(str, inBase);
                return inBase;
            }
        }

        const id = this.baseCount + this.list.length;
        this.list.push(str);
        own.set(str, id);
        return id;
    }

    get(id: number): string {
        if (id < this.baseCount) {
            // Hydration no longer decodes the table up front, so a migration
            // that reads the same handful of ids over and over would decode
            // them over and over. Past a few dozen reads the cache is the
            // cheaper side of that trade; a one-off read never pays for it.
            if (this.baseReads < BASE_READS_BEFORE_CACHING && ++this.baseReads === BASE_READS_BEFORE_CACHING) {
                this.base!.memoize();
            }
            return this.base!.get(id);
        }
        return this.list[id - this.baseCount] ?? "";
    }

    get size(): number {
        return this.baseCount + this.list.length;
    }

    serialize(): { offsets: Uint32Array; data: Uint8Array } {
        const base = this.base;
        const list = this.list;

        // Nothing was added on top of the table we hydrated from, so that table
        // already *is* what we would emit. A migration that does not touch
        // strings pays nothing here beyond the copy into the new buffer.
        if (base !== null && list.length === 0) return base.sections();

        const carriedFrom = base === null ? null : base.sections();
        const carried = carriedFrom === null ? 0 : this.baseCount;
        const carriedBytes = carriedFrom === null ? 0 : carriedFrom.offsets[carried];

        const count = carried + list.length;
        const offsets = new Uint32Array(count + 1);
        if (carriedFrom !== null) offsets.set(carriedFrom.offsets.subarray(0, carried + 1));

        // One byte per code unit is exact for ASCII and the floor for anything
        // else, so this is the smallest estimate that is never silly. The old
        // `length * 3` worst case allocated three times the buffer a Latin
        // string table actually needs and held it until the snapshot was built.
        let estimate = carriedBytes + 16;
        for (let i = 0; i < list.length; i++) estimate += list[i].length;

        let buf = new Uint8Array(estimate);
        if (carriedFrom !== null) buf.set(carriedFrom.data.subarray(0, carriedBytes));
        let pos = carriedBytes;

        for (let i = 0; i < list.length; i++) {
            const s = list[i];

            // encodeInto stops on a code-point boundary when it runs out of room
            // and reports how far it got — cheaper than reserving the worst case
            // per string, and it grows only when a string really needs it.
            while (s.length !== 0) {
                const { read, written } = ENCODER.encodeInto(s, buf.subarray(pos));
                if (read === s.length) {
                    pos += written;
                    break;
                }

                const grown = new Uint8Array(Math.max(buf.length * 2, pos + s.length * 3));
                grown.set(buf.subarray(0, pos));
                buf = grown;
            }

            offsets[carried + i + 1] = pos;
        }

        return { offsets, data: buf.subarray(0, pos) };
    }
}

export class StringReader {
    private readonly buf: Buffer | null;
    private readonly bytes: Uint8Array;
    private readonly n: number;

    /** Open addressed `hash -> id + 1`, built on the first `idOf`. */
    private index: Uint32Array | null = null;
    private indexMask = 0;
    private cache: (string | undefined)[] | null = null;

    constructor(
        private readonly offsets: Uint32Array,
        data: Uint8Array,
    ) {
        this.bytes = data;
        this.n = offsets.length - 1;
        this.buf = HAS_BUFFER ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
    }

    get count(): number {
        return this.n;
    }

    /** The two sections backing this table, as views. Not copies. */
    sections(): { offsets: Uint32Array; data: Uint8Array } {
        return { offsets: this.offsets, data: this.bytes };
    }

    /**
     * Trade memory for repeat reads: every `get` after this keeps its string.
     * Off by default — materialising a table is exactly what a zero-copy
     * snapshot exists to avoid — but worth it when a hot loop resolves the same
     * handful of ids over and over.
     */
    memoize(): this {
        if (this.cache === null) this.cache = new Array(this.n);
        return this;
    }

    get(id: number): string {
        if (id <= 0 || id >= this.n) return "";

        const cache = this.cache;
        if (cache !== null) {
            const hit = cache[id];
            return hit !== undefined ? hit : (cache[id] = this.decode(id));
        }

        return this.decode(id);
    }

    private decode(id: number): string {
        const start = this.offsets[id];
        const end = this.offsets[id + 1];
        if (this.buf) return this.buf.toString("utf8", start, end);
        return DECODER.decode(this.bytes.subarray(start, end));
    }

    /**
     * The id `key` was interned under, or -1.
     *
     * Backs dedupe when a migration adds strings on top of an existing table.
     * The index is over the stored *bytes*, so answering this never decodes the
     * table — which is the whole reason a migration can hydrate from a 300 MB
     * snapshot without paying for it.
     */
    idOf(key: string): number {
        if (key.length === 0) return 0;
        if (this.n <= 1) return -1;
        if (this.index === null) this.buildIndex();

        const index = this.index!;
        const mask = this.indexMask;
        let slot = hashUtf8OfString(key) & mask;

        while (true) {
            const entry = index[slot];
            if (entry === 0) return -1;
            if (this.equals(entry - 1, key)) return entry - 1;
            slot = (slot + 1) & mask;
        }
    }

    private buildIndex() {
        const n = this.n;
        let capacity = 8;
        while (capacity < n * 2) capacity *= 2;

        const index = new Uint32Array(capacity);
        const mask = capacity - 1;
        const offsets = this.offsets;
        const bytes = this.bytes;

        for (let id = 1; id < n; id++) {
            let slot = hashUtf8Bytes(bytes, offsets[id], offsets[id + 1]) & mask;
            while (index[slot] !== 0) slot = (slot + 1) & mask;
            index[slot] = id + 1;
        }

        this.indexMask = mask;
        this.index = index;
    }

    /**
     * `get(id) === key` without materialising the string.
     *
     * hashLookup verifies every probe hit against the key the caller passed;
     * decoding a string only to drop it one comparison later made every lookup
     * allocate. UTF-8 is never shorter than one byte per UTF-16 code unit, and
     * is strictly longer for every non-ASCII one — so an equal length proves
     * both sides are ASCII and the bytes compare directly against code units.
     */
    equals(id: number, key: string): boolean {
        if (id <= 0 || id >= this.n) return key.length === 0;

        const start = this.offsets[id];
        const byteLength = this.offsets[id + 1] - start;
        if (byteLength < key.length) return false;

        if (byteLength === key.length) {
            const bytes = this.bytes;
            for (let i = 0; i < byteLength; i++) {
                const c = key.charCodeAt(i);
                if (c > 0x7f || bytes[start + i] !== c) return false;
            }
            return true;
        }

        return this.get(id) === key;
    }
}

export const STRING_TABLE_SIGNATURE = "stringTable";

class StringTableField implements Field<StringInterner, StringReader> {
    sectionCount = 2;
    signature() {
        return STRING_TABLE_SIGNATURE;
    }
    createBuilder(ctx: BuilderContext) {
        return ctx.strings;
    }
    finalize(builder: StringInterner): FieldSection[] {
        const { offsets, data } = builder.serialize();
        return [{ data: offsets }, { data }];
    }
    createReader(ctx: ReaderContext): StringReader {
        return new StringReader(ctx.view(0, Uint32Array), ctx.sections[1]);
    }
}

export const stringTable = () => new StringTableField();
