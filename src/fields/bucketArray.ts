import type { AnyTypedArray, BuilderContext, Field, FieldSection, ReaderContext } from "../types.ts";
import { NumberBuffer, U32Buffer } from "../growable.ts";
import type { StringInterner, StringReader } from "../strings.ts";
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
} from "../columns.ts";

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
