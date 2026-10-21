// Byte-level UTF-8 helpers for the string table: hashing a string the way its
// encoded bytes would hash, and comparing stored bytes against a JS string —
// both without encoding or decoding anything. They exist so the interner and
// the reader can dedupe and verify against a table they never materialise.

// FNV-1a over UTF-8 bytes. This one never reaches disk — it only places entries
// in the interner's in-memory dedupe index — so it is free to be whatever is
// cheapest, and a probe hit is always verified with `equals` before it counts.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const hashUtf8Bytes = (bytes: Uint8Array, start: number, end: number): number => {
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
export const hashUtf8OfString = (s: string): number => {
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

/**
 * Does `bytes[start..end)`, read as UTF-8, spell exactly `key`? `undefined`
 * when the bytes are not well-formed UTF-8, so the caller can let the decoder
 * decide what such a sequence turns into.
 *
 * The table is always TextEncoder output, so this never sees a malformed
 * sequence in practice — an unpaired surrogate in the original was stored as
 * U+FFFD, which is also what `get()` hands back, so comparing the decoded code
 * points against the key's code units is the same test `get(id) === key` is.
 * The well-formedness checks exist so a corrupt section still gets exactly the
 * decoder's answer rather than a guess.
 */
export const equalsUtf8 = (bytes: Uint8Array, start: number, end: number, key: string): boolean | undefined => {
    const length = key.length;
    let i = start;
    let k = 0;

    while (i < end && k < length) {
        const b0 = bytes[i];

        if (b0 < 0x80) {
            if (key.charCodeAt(k) !== b0) return false;
            i += 1;
            k += 1;
            continue;
        }

        // A continuation byte in lead position, or an overlong two-byte form.
        if (b0 < 0xc2) return undefined;

        if (b0 < 0xe0) {
            if (i + 1 >= end) return undefined;
            const b1 = bytes[i + 1];
            if ((b1 & 0xc0) !== 0x80) return undefined;
            if (key.charCodeAt(k) !== (((b0 & 0x1f) << 6) | (b1 & 0x3f))) return false;
            i += 2;
            k += 1;
            continue;
        }

        if (b0 < 0xf0) {
            if (i + 2 >= end) return undefined;
            const b1 = bytes[i + 1];
            const b2 = bytes[i + 2];
            if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return undefined;
            const c = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
            // Overlong, or an encoded surrogate — neither is UTF-8.
            if (c < 0x800 || (c >= 0xd800 && c <= 0xdfff)) return undefined;
            if (key.charCodeAt(k) !== c) return false;
            i += 3;
            k += 1;
            continue;
        }

        if (b0 >= 0xf5 || i + 3 >= end) return undefined;
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        const b3 = bytes[i + 3];
        if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return undefined;
        const point = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        if (point < 0x10000 || point > 0x10ffff) return undefined;

        // A valid four-byte sequence is a surrogate pair on the string side.
        if (k + 1 >= length) return false;
        const offset = point - 0x10000;
        if (key.charCodeAt(k) !== (0xd800 | (offset >> 10))) return false;
        if (key.charCodeAt(k + 1) !== (0xdc00 | (offset & 0x3ff))) return false;
        i += 4;
        k += 2;
    }

    return i === end && k === length;
};
