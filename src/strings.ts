import type { BuilderContext, Field, FieldSection, ReaderContext } from "./types";

const HAS_BUFFER = typeof Buffer !== "undefined";
const DECODER = new TextDecoder();

export class StringInterner {
    private map = new Map<string, number>();
    private list: string[] = [];

    constructor() {
        this.add("");
    }

    static hydrate(reader: StringReader): StringInterner {
        const interner = new StringInterner();
        const count = reader.count;
        for (let i = 1; i < count; i++) {
            interner.add(reader.get(i));
        }
        return interner;
    }

    add(str: string = ""): number {
        let id = this.map.get(str);
        if (id === undefined) {
            id = this.list.length;
            this.list.push(str);
            this.map.set(str, id);
        }
        return id;
    }

    get(id: number): string {
        return this.list[id] ?? "";
    }

    get size(): number {
        return this.list.length;
    }

    serialize(): { offsets: Uint32Array; data: Uint8Array } {
        const encoder = new TextEncoder();
        const count = this.list.length;
        const offsets = new Uint32Array(count + 1);

        let estimate = 16;
        for (let i = 0; i < count; i++) estimate += this.list[i].length * 3;

        let buf = new Uint8Array(estimate);
        let pos = 0;

        for (let i = 0; i < count; i++) {
            const s = this.list[i];
            if (s.length !== 0) {
                const needed = pos + s.length * 3;

                if (needed > buf.length) {
                    const nb = new Uint8Array(Math.max(buf.length * 2, needed));
                    nb.set(buf.subarray(0, pos));
                    buf = nb;
                }

                const { written } = encoder.encodeInto(s, buf.subarray(pos));
                pos += written;
            }

            offsets[i + 1] = pos;
        }

        return { offsets, data: buf.subarray(0, pos) };
    }
}

export class StringReader {
    private buf: Buffer | null;
    private bytes: Uint8Array;

    constructor(
        private offsets: Uint32Array,
        data: Uint8Array,
    ) {
        this.bytes = data;
        this.buf = HAS_BUFFER ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
    }

    get count(): number {
        return this.offsets.length - 1;
    }

    get(id: number): string {
        if (id <= 0 || id >= this.count) return "";
        if (this.buf) return this.buf.toString("utf8", this.offsets[id], this.offsets[id + 1]);
        return DECODER.decode(this.bytes.subarray(this.offsets[id], this.offsets[id + 1]));
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
