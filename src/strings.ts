import type { BuilderContext, Field, FieldSection, ReaderContext } from "./types.ts";

const HAS_BUFFER = typeof Buffer !== "undefined";
const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

export class StringInterner {
    private map = new Map<string, number>();
    private list: string[] = [];

    constructor() {
        this.add("");
    }

    static hydrate(reader: StringReader): StringInterner {
        const interner = new StringInterner();
        const count = reader.count;
        // A serialised table is already deduped, so the Map probe in add() can
        // only ever miss. Skipping it halves the string hashing done here, and
        // this runs over the whole table once per migration step.
        for (let i = 1; i < count; i++) interner.append(reader.get(i));
        return interner;
    }

    private append(str: string): number {
        const id = this.list.length;
        this.list.push(str);
        this.map.set(str, id);
        return id;
    }

    add(str: string = ""): number {
        const existing = this.map.get(str);
        return existing === undefined ? this.append(str) : existing;
    }

    get(id: number): string {
        return this.list[id] ?? "";
    }

    get size(): number {
        return this.list.length;
    }

    serialize(): { offsets: Uint32Array; data: Uint8Array } {
        const list = this.list;
        const count = list.length;
        const offsets = new Uint32Array(count + 1);

        // One byte per code unit is exact for ASCII and the floor for anything
        // else, so this is the smallest estimate that is never silly. The old
        // `length * 3` worst case allocated three times the buffer a Latin
        // string table actually needs and held it until the snapshot was built.
        let estimate = 16;
        for (let i = 0; i < count; i++) estimate += list[i].length;

        let buf = new Uint8Array(estimate);
        let pos = 0;

        for (let i = 0; i < count; i++) {
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

            offsets[i + 1] = pos;
        }

        return { offsets, data: buf.subarray(0, pos) };
    }
}

export class StringReader {
    private readonly buf: Buffer | null;
    private readonly bytes: Uint8Array;
    private readonly n: number;

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

    get(id: number): string {
        if (id <= 0 || id >= this.n) return "";
        const start = this.offsets[id];
        const end = this.offsets[id + 1];
        if (this.buf) return this.buf.toString("utf8", start, end);
        return DECODER.decode(this.bytes.subarray(start, end));
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
