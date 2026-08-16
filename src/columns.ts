import { NumberBuffer, rangeOf, U32Buffer } from "./growable.ts";
import type { AnyTypedArray, ReaderContext, TypedArrayConstructor } from "./types.ts";
import type { StringInterner, StringReader } from "./strings.ts";

export function assertNumericRange(
    ctor: TypedArrayConstructor,
    values: ArrayLike<number>,
    label: string,
): void {
    const [min, max] = rangeOf(ctor);
    if (min === -Infinity) return;

    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v < min || v > max) {
            throw new RangeError(
                `${label}: value ${v} at index ${i} does not fit ${ctor.name} [${min}, ${max}]`,
            );
        }
    }
}

export type ColumnSpec = NumColumnSpec<number, TypedArrayConstructor> | StringRefColumnSpec;

export interface NumColumnSpec<
    S extends number = number,
    C extends TypedArrayConstructor = TypedArrayConstructor,
> {
    readonly kind: "num";
    readonly ctor: C;
    readonly stride: S;
    readonly tag: string;
}

export interface StringRefColumnSpec {
    readonly kind: "stringRef";
    readonly tag: string;
}

export const numColumn = <C extends TypedArrayConstructor, S extends number>(
    ctor: C,
    stride: S,
): NumColumnSpec<S, C> => ({
    kind: "num",
    ctor,
    stride,
    tag: `${ctor.name}:${stride}`,
});

export const u8 = () => numColumn(Uint8Array, 1 as const);
export const u16 = () => numColumn(Uint16Array, 1 as const);
export const u32 = () => numColumn(Uint32Array, 1 as const);
export const i8 = () => numColumn(Int8Array, 1 as const);
export const i16 = () => numColumn(Int16Array, 1 as const);
export const i32 = () => numColumn(Int32Array, 1 as const);
export const f32 = () => numColumn(Float32Array, 1 as const);
export const f64 = () => numColumn(Float64Array, 1 as const);
export const i32Pair = () => numColumn(Int32Array, 2 as const);
export const stringRef = (): StringRefColumnSpec => ({ kind: "stringRef", tag: "strRef" });

export type ColumnWriteValue<S extends ColumnSpec> =
    S extends NumColumnSpec<infer ST> ? (ST extends 1 ? number : ArrayLike<number>) : string;

export type ColumnReadValue<S extends ColumnSpec> =
    S extends NumColumnSpec<infer ST> ? (ST extends 1 ? number : number[]) : string;

export type ColumnView<S extends ColumnSpec> =
    S extends NumColumnSpec<number, infer C> ? InstanceType<C> : Uint32Array;

export type Columns = Record<string, ColumnSpec>;

export const columnsSignature = (cols: Columns): string =>
    Object.keys(cols)
        .map((k) => `${k}=${cols[k].tag}`)
        .join(",");

export class ColumnStore<C extends Columns> {
    // Parallel arrays, resolved once in the constructor. `push` used to call
    // Object.keys(this.columns) on every item, allocating a fresh string array
    // per row written.
    private readonly keys: string[];
    private readonly specs: ColumnSpec[];
    private readonly stores: (NumberBuffer | U32Buffer)[];
    private readonly firstStride: number;

    constructor(
        public readonly columns: C,
        private readonly strings: StringInterner,
        label?: string,
    ) {
        this.keys = Object.keys(columns);
        this.specs = this.keys.map((key) => columns[key]);
        this.stores = this.specs.map((spec, i) => {
            const name = label === undefined ? this.keys[i] : `${label}.${this.keys[i]}`;
            return spec.kind === "num" ? new NumberBuffer(spec.ctor, name) : new U32Buffer();
        });

        const first = this.specs[0];
        this.firstStride = first !== undefined && first.kind === "num" ? first.stride : 1;
    }

    /** Live views of what has been written so far, keyed by column name. */
    get buffers(): { readonly [K in keyof C]: AnyTypedArray } {
        const result: Record<string, AnyTypedArray> = {};
        for (let i = 0; i < this.keys.length; i++) result[this.keys[i]] = this.stores[i].view;
        return result as { readonly [K in keyof C]: AnyTypedArray };
    }

    push(item: { [K in keyof C]: ColumnWriteValue<C[K]> }) {
        const { keys, specs, stores } = this;

        for (let i = 0; i < keys.length; i++) {
            const spec = specs[i];
            const value = (item as Record<string, unknown>)[keys[i]];

            if (spec.kind === "stringRef") {
                (stores[i] as U32Buffer).push(this.strings.add((value as string) ?? ""));
                continue;
            }

            const store = stores[i] as NumberBuffer;
            if (spec.stride === 1) {
                store.push(value as number);
            } else {
                store.pushStride(value as ArrayLike<number>, spec.stride);
            }
        }
    }

    itemCount(): number {
        if (this.stores.length === 0) return 0;
        return this.stores[0].length / this.firstStride;
    }

    finalize(): AnyTypedArray[] {
        const result: AnyTypedArray[] = new Array(this.stores.length);
        for (let i = 0; i < this.stores.length; i++) result[i] = this.stores[i].view;
        return result;
    }
}

export const readColumns = <C extends Columns>(
    columns: C,
    ctx: ReaderContext,
    startSectionIdx: number,
): { [K in keyof C]: ColumnView<C[K]> } => {
    const result: Record<string, AnyTypedArray> = {};
    let i = startSectionIdx;

    for (const key of Object.keys(columns)) {
        const spec = columns[key];
        result[key] = spec.kind === "num" ? ctx.view(i, spec.ctor as any) : ctx.view(i, Uint32Array);
        i++;
    }

    return result as { [K in keyof C]: ColumnView<C[K]> };
};

export const readColumnValue = <S extends ColumnSpec>(
    spec: S,
    view: ColumnView<S>,
    offset: number,
    strings: StringReader,
): ColumnReadValue<S> => {
    if (spec.kind === "num") {
        if (spec.stride === 1) return view[offset] as ColumnReadValue<S>;

        const stride = spec.stride;
        const out: number[] = new Array(stride);
        const base = offset * stride;
        for (let s = 0; s < stride; s++) out[s] = (view as AnyTypedArray)[base + s] as number;
        return out as ColumnReadValue<S>;
    }

    return strings.get((view as Uint32Array)[offset]) as ColumnReadValue<S>;
};
