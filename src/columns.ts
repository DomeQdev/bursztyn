import type { AnyTypedArray, ReaderContext, TypedArrayConstructor } from "./types";
import type { StringInterner, StringReader } from "./strings";

const INTEGER_RANGES: Record<string, [min: number, max: number]> = {
    Int8Array: [-128, 127],
    Uint8Array: [0, 255],
    Uint8ClampedArray: [0, 255],
    Int16Array: [-32768, 32767],
    Uint16Array: [0, 65535],
    Int32Array: [-2147483648, 2147483647],
    Uint32Array: [0, 4294967295],
};

export function assertNumericRange(
    ctor: TypedArrayConstructor,
    values: ArrayLike<number>,
    label: string,
): void {
    const range = INTEGER_RANGES[ctor.name];
    if (!range) return;
    const [min, max] = range;
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
    readonly buffers: { [K in keyof C]: number[] } = {} as any;

    constructor(
        public readonly columns: C,
        private readonly strings: StringInterner,
    ) {
        for (const key of Object.keys(columns)) (this.buffers as any)[key] = [];
    }

    push(item: { [K in keyof C]: ColumnWriteValue<C[K]> }) {
        for (const key of Object.keys(this.columns)) {
            const spec = this.columns[key];
            const value = (item as any)[key];
            const buf = (this.buffers as any)[key] as number[];

            if (spec.kind === "num") {
                if (spec.stride === 1) {
                    buf.push(value as number);
                } else {
                    const arr = value as ArrayLike<number>;
                    for (let i = 0; i < spec.stride; i++) buf.push(arr[i] ?? 0);
                }
            } else {
                buf.push(this.strings.add((value as string) ?? ""));
            }
        }
    }

    itemCount(): number {
        const firstKey = Object.keys(this.columns)[0];
        if (firstKey === undefined) return 0;
        const spec = this.columns[firstKey];
        const len = ((this.buffers as any)[firstKey] as number[]).length;
        return spec.kind === "num" && spec.stride !== 1 ? len / spec.stride : len;
    }

    finalize(): AnyTypedArray[] {
        const result: AnyTypedArray[] = [];
        for (const key of Object.keys(this.columns)) {
            const spec = this.columns[key];
            const buf = (this.buffers as any)[key] as number[];
            if (spec.kind === "num") {
                assertNumericRange(spec.ctor, buf, key);
                result.push(new spec.ctor(buf) as AnyTypedArray);
            } else {
                result.push(new Uint32Array(buf));
            }
        }
        return result;
    }
}

export const readColumns = <C extends Columns>(
    columns: C,
    ctx: ReaderContext,
    startSectionIdx: number,
): { [K in keyof C]: ColumnView<C[K]> } => {
    const result: any = {};
    let i = startSectionIdx;

    for (const key of Object.keys(columns)) {
        const spec = columns[key];
        if (spec.kind === "num") {
            result[key] = ctx.view(i, spec.ctor as any);
        } else {
            result[key] = ctx.view(i, Uint32Array);
        }

        i++;
    }

    return result;
};

export const readColumnValue = <S extends ColumnSpec>(
    spec: S,
    view: ColumnView<S>,
    offset: number,
    strings: StringReader,
): ColumnReadValue<S> => {
    if (spec.kind === "num") {
        if (spec.stride === 1) return view[offset] as ColumnReadValue<S>;

        const out: number[] = [];
        for (let s = 0; s < spec.stride; s++) {
            out.push((view as any)[offset * spec.stride + s]);
        }
        return out as ColumnReadValue<S>;
    }

    return strings.get((view as Uint32Array)[offset]) as ColumnReadValue<S>;
};
