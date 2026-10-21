// The fields with no index over them: one section of values, read back as the
// typed array it was written as. Everything else in this folder is built from
// the same pieces plus a lookup structure.
import type { AnyTypedArray, BuilderContext, Field, FieldSection, ReaderContext, TypedArrayConstructor } from "../types.ts";
import { NumberBuffer, U32Buffer } from "../growable.ts";
import type { StringInterner } from "../strings.ts";

export class NumArrayBuilder {
    private readonly buffer: NumberBuffer;

    constructor(ctor: TypedArrayConstructor, label: string = ctor.name) {
        this.buffer = new NumberBuffer(ctor, label);
    }

    /** A live view of what has been pushed. Values land in the target type directly. */
    get values(): AnyTypedArray {
        return this.buffer.view;
    }

    push(v: number) {
        this.buffer.push(v);
    }

    pushMany(arr: ArrayLike<number>) {
        this.buffer.pushMany(arr);
    }

    setFrom(arr: ArrayLike<number>) {
        this.buffer.clear();
        this.buffer.pushMany(arr);
    }

    get length() {
        return this.buffer.length;
    }

    finalize(): AnyTypedArray {
        return this.buffer.view;
    }
}

class NumArrayField<TA extends TypedArrayConstructor> implements Field<NumArrayBuilder, InstanceType<TA>> {
    sectionCount = 1;
    constructor(public readonly ctor: TA) {}
    signature() {
        return `num:${this.ctor.name}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new NumArrayBuilder(this.ctor, ctx.name ?? this.ctor.name);
    }
    finalize(builder: NumArrayBuilder): FieldSection[] {
        return [{ data: builder.finalize() }];
    }
    createReader(ctx: ReaderContext): InstanceType<TA> {
        return ctx.view(0, this.ctor as any) as InstanceType<TA>;
    }
}

export const numArray = <TA extends TypedArrayConstructor>(ctor: TA) => new NumArrayField(ctor);

export class StringRefArrayBuilder {
    private readonly ids = new U32Buffer();
    constructor(private strings: StringInterner) {}
    pushString(s: string) {
        this.ids.push(this.strings.add(s));
    }
    pushId(id: number) {
        this.ids.push(id);
    }
    get length() {
        return this.ids.length;
    }
    finalize(): Uint32Array {
        return this.ids.view;
    }
}

class StringRefArrayField implements Field<StringRefArrayBuilder, Uint32Array> {
    sectionCount = 1;
    signature() {
        return "stringRefArray";
    }
    createBuilder(ctx: BuilderContext) {
        return new StringRefArrayBuilder(ctx.strings);
    }
    finalize(builder: StringRefArrayBuilder): FieldSection[] {
        return [{ data: builder.finalize() }];
    }
    createReader(ctx: ReaderContext): Uint32Array {
        return ctx.view(0, Uint32Array);
    }
}

export const stringRefArray = () => new StringRefArrayField();

export class SingleStringRefBuilder {
    public id = 0;
    constructor(private strings: StringInterner) {}
    set(value: string) {
        this.id = this.strings.add(value);
    }
}

class SingleStringRefField implements Field<SingleStringRefBuilder, string> {
    sectionCount = 1;
    signature() {
        return "singleStringRef";
    }
    createBuilder(ctx: BuilderContext) {
        return new SingleStringRefBuilder(ctx.strings);
    }
    finalize(b: SingleStringRefBuilder): FieldSection[] {
        return [{ data: new Uint32Array([b.id]) }];
    }
    createReader(ctx: ReaderContext): string {
        const arr = ctx.view(0, Uint32Array);
        return ctx.strings.get(arr[0] ?? 0);
    }
}

export const singleStringRef = () => new SingleStringRefField();

export class RawBytesBuilder {
    public data: Uint8Array = new Uint8Array(0);
    set(data: Uint8Array) {
        this.data = data;
    }
}

class RawBytesField implements Field<RawBytesBuilder, Uint8Array> {
    sectionCount = 1;
    signature() {
        return "rawBytes";
    }
    createBuilder() {
        return new RawBytesBuilder();
    }
    finalize(builder: RawBytesBuilder): FieldSection[] {
        return [{ data: builder.data }];
    }
    createReader(ctx: ReaderContext): Uint8Array {
        return ctx.sections[0];
    }
}

export const rawBytes = () => new RawBytesField();
