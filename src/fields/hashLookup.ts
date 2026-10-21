import type { Field, FieldSection, ReaderContext } from "../types.ts";
import { hashState, hashString, splitHash } from "../hash.ts";
import { U32Buffer } from "../growable.ts";

/**
 * Open-addressed table over three parallel u32 columns. Entries arrive as
 * struct-of-arrays rather than an array of `{hashLow, hashHigh, value}` records:
 * a million keys used to mean a million short-lived objects before a single byte
 * was written.
 */
export const buildHashTable = (keys: { lo: Uint32Array; hi: Uint32Array; values: Uint32Array }) => {
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
