export const hashState = { lo: 0, hi: 0 };

const fmix32 = (h: number): number => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
};

export const hashString = (s: string): void => {
    let h1 = 0x9747b28c | 0;
    let h2 = 0x2f2fdd8b | 0;

    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);

        let k1 = Math.imul(c, 0xcc9e2d51);
        k1 = (k1 << 15) | (k1 >>> 17);
        k1 = Math.imul(k1, 0x1b873593);
        h1 ^= k1;
        h1 = (h1 << 13) | (h1 >>> 19);
        h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;

        let k2 = Math.imul(c ^ 0x5bd1e995, 0x85ebca6b);
        k2 = (k2 << 17) | (k2 >>> 15);
        k2 = Math.imul(k2, 0xc2b2ae35);
        h2 ^= k2;
        h2 = (h2 << 11) | (h2 >>> 21);
        h2 = (Math.imul(h2, 5) + 0x38495ab5) | 0;
    }

    hashState.lo = fmix32(h1 ^ s.length);
    hashState.hi = fmix32(((h2 ^ s.length) + h1) | 0);
};

export const splitHash = (hash: bigint): void => {
    hashState.lo = Number(hash & 0xffffffffn) >>> 0;
    hashState.hi = Number((hash >> 32n) & 0xffffffffn) >>> 0;
};

export const hashToBigint = (): bigint => (BigInt(hashState.hi) << 32n) | BigInt(hashState.lo);

export const hashStringToBigint = (s: string): bigint => {
    hashString(s);
    return hashToBigint();
};
