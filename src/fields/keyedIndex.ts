import type { BuilderContext, Field, FieldSection, ReaderContext } from "../types.ts";
import type { StringInterner } from "../strings.ts";
import type { ColumnSpec, ColumnView, ColumnWriteValue } from "../columns.ts";
import { HashLookupBuilder, HashLookupReader } from "./hashLookup.ts";
import { BucketArrayBuilder, BucketArrayReader } from "./bucketArray.ts";

export class KeyedIndexBuilder<S extends ColumnSpec> {
    private lookup = new HashLookupBuilder();
    private buckets: BucketArrayBuilder<S>;

    constructor(spec: S, strings: StringInterner, label?: string) {
        this.buckets = new BucketArrayBuilder(spec, strings, label);
    }

    add(key: string, values: ArrayLike<ColumnWriteValue<S>>) {
        this.lookup.add(key, this.buckets.bucketCount);
        for (let i = 0; i < values.length; i++) this.buckets.push(values[i]);
        this.buckets.endBucket();
    }

    finalize() {
        const lk = this.lookup.finalize();
        const bk = this.buckets.finalize();
        return { ...lk, ptr: bk.ptr, data: bk.data };
    }
}

export class KeyedIndexReader<S extends ColumnSpec> {
    constructor(
        private lookup: HashLookupReader,
        private buckets: BucketArrayReader<S>,
    ) {}

    find(key: string): ColumnView<S> | undefined {
        const bucketIdx = this.lookup.find(key);
        if (bucketIdx === undefined) return undefined;
        return this.buckets.slice(bucketIdx);
    }
}

class KeyedIndexField<S extends ColumnSpec> implements Field<KeyedIndexBuilder<S>, KeyedIndexReader<S>> {
    sectionCount = 5;
    constructor(private spec: S) {}
    signature() {
        return `keyedIndex:${this.spec.tag}`;
    }
    createBuilder(ctx: BuilderContext) {
        return new KeyedIndexBuilder(this.spec, ctx.strings, ctx.name);
    }
    finalize(builder: KeyedIndexBuilder<S>): FieldSection[] {
        const finalised = builder.finalize();
        return [
            { data: finalised.keysLow },
            { data: finalised.keysHigh },
            { data: finalised.values },
            { data: finalised.ptr },
            { data: finalised.data },
        ];
    }
    createReader(ctx: ReaderContext): KeyedIndexReader<S> {
        const lookup = new HashLookupReader(
            ctx.view(0, Uint32Array),
            ctx.view(1, Uint32Array),
            ctx.view(2, Uint32Array),
        );
        const ptr = ctx.view(3, Uint32Array);
        const data =
            this.spec.kind === "num"
                ? (ctx.view(4, this.spec.ctor as any) as ColumnView<S>)
                : (ctx.view(4, Uint32Array) as ColumnView<S>);
        const buckets = new BucketArrayReader(ptr, data, this.spec, ctx.strings);
        return new KeyedIndexReader(lookup, buckets);
    }
}

export const keyedIndex = <S extends ColumnSpec>(spec: S) => new KeyedIndexField(spec);
