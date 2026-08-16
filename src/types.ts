import type { StringInterner, StringReader } from "./strings.ts";

export type AnyTypedArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array;

export type TypedArrayConstructor =
    | Int8ArrayConstructor
    | Uint8ArrayConstructor
    | Uint8ClampedArrayConstructor
    | Int16ArrayConstructor
    | Uint16ArrayConstructor
    | Int32ArrayConstructor
    | Uint32ArrayConstructor
    | Float32ArrayConstructor
    | Float64ArrayConstructor;

export interface FieldSection {
    data: AnyTypedArray;
}

export interface Field<Builder = unknown, Reader = unknown> {
    readonly sectionCount: number;
    signature(): string;
    createBuilder(ctx: BuilderContext): Builder;
    finalize(builder: Builder, name?: string): FieldSection[];
    createReader(ctx: ReaderContext): Reader;
}

export interface BuilderContext {
    strings: StringInterner;
    /** The field being built. Used to name the field in range errors. */
    name?: string;
}

export interface ReaderContext {
    sections: Uint8Array[];
    view<T extends AnyTypedArray>(
        sectionIndex: number,
        ctor: {
            new (buffer: ArrayBufferLike, byteOffset: number, length: number): T;
            BYTES_PER_ELEMENT: number;
        },
    ): T;
    strings: StringReader;
    resolve<T>(name: string): T;
}

export type ReaderOf<F> = F extends Field<any, infer R> ? R : never;
export type BuilderOf<F> = F extends Field<infer B, any> ? B : never;

export type SchemaShape = Record<string, Field<any, any>>;

export type Builders<S extends SchemaShape> = {
    [K in keyof S]: S[K] extends Field<infer B, any> ? B : never;
};

export type Readers<S extends SchemaShape> = {
    [K in keyof S]: S[K] extends Field<any, infer R> ? R : never;
};

export type SnapshotSource = Uint8Array | ArrayBuffer | SharedArrayBuffer;

export type NoInference<T> = [T][T extends any ? 0 : never];
