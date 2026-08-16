import { numColumn, stringRef, type ColumnSpec, type Columns } from "./columns.ts";
import { UnknownSignatureError } from "./errors.ts";
import {
    bucketArray,
    hashLookup,
    keyedIndex,
    multiBucketArray,
    numArray,
    pairIndex,
    rawBytes,
    singleStringRef,
    sortedU32Index,
    stringRefArray,
    trigramIndex,
} from "./fields.ts";
import { stringTable } from "./strings.ts";
import type { Field, TypedArrayConstructor } from "./types.ts";

const TYPED_ARRAYS: Record<string, TypedArrayConstructor> = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
};

const typedArrayByName = (name: string, signature: string): TypedArrayConstructor => {
    const ctor = TYPED_ARRAYS[name];
    if (!ctor) throw new UnknownSignatureError(signature);
    return ctor;
};

const columnFromTag = (tag: string, signature: string): ColumnSpec => {
    if (tag === "strRef") return stringRef();

    const sep = tag.lastIndexOf(":");
    if (sep === -1) throw new UnknownSignatureError(signature);

    const stride = Number(tag.slice(sep + 1));
    if (!Number.isInteger(stride) || stride < 1) throw new UnknownSignatureError(signature);

    return numColumn(typedArrayByName(tag.slice(0, sep), signature), stride);
};

const columnsFromTags = (spec: string, signature: string): Columns => {
    const columns: Columns = {};
    if (spec.length === 0) return columns;

    for (const part of spec.split(",")) {
        const eq = part.indexOf("=");
        if (eq === -1) throw new UnknownSignatureError(signature);
        columns[part.slice(0, eq)] = columnFromTag(part.slice(eq + 1), signature);
    }

    return columns;
};

export const fieldFromSignature = (signature: string): Field<any, any> => {
    const sep = signature.indexOf(":");
    const kind = sep === -1 ? signature : signature.slice(0, sep);
    const rest = sep === -1 ? "" : signature.slice(sep + 1);

    switch (kind) {
        case "stringTable":
            return stringTable();
        case "stringRefArray":
            return stringRefArray();
        case "singleStringRef":
            return singleStringRef();
        case "trigramIndex":
            return trigramIndex();
        case "sortedU32Index":
            return sortedU32Index();
        case "rawBytes":
            return rawBytes();
        case "num":
            return numArray(typedArrayByName(rest, signature));
        case "hashLookup":
            return hashLookup(rest.length > 0 ? { verifyVia: rest } : undefined);
        case "bucketArray":
            return bucketArray(columnFromTag(rest, signature));
        case "keyedIndex":
            return keyedIndex(columnFromTag(rest, signature));
        case "multiBucketArray":
            return multiBucketArray(columnsFromTags(rest, signature));
        case "pairIndex":
            return pairIndex(columnsFromTags(rest, signature));
        default:
            throw new UnknownSignatureError(signature);
    }
};
