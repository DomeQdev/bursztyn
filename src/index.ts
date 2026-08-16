export { defineSchema, migration, Schema } from "./schema";
export type { OpenOptions, OpenResult, SchemaDefinition } from "./schema";

export { SnapshotBuilder } from "./builder";

export {
    migrateSnapshot,
    resolveChain,
    type MigrateOptions,
    type Migration,
    type MigrationContext,
    type MigrationReport,
    type MigrationStepReport,
    type MigrationTarget,
    type PreviousSnapshot,
} from "./migrate";

export {
    assembleSnapshot,
    createReaders,
    createReadersFromLayout,
    diffManifest,
    inspect,
    isSnapshot,
    layoutFromManifest,
    readHeader,
    readSchemaHash,
    readSchemaVersion,
    FORMAT_VERSION,
    type FieldStat,
    type ManifestEntry,
    type SnapshotHeader,
    type SnapshotInfo,
} from "./format";

export { compileSchema, type CompiledSchema, type FieldLayout } from "./layout";

export {
    openSnapshotFile,
    readSnapshotFile,
    writeSnapshotFile,
    type OpenFileOptions,
    type ReadFileOptions,
} from "./io";

export {
    BursztynError,
    CarryConflictError,
    FormatError,
    formatDiff,
    MigrationDataLossError,
    MigrationPathError,
    SchemaMismatchError,
    UnknownSignatureError,
    type FieldDiff,
} from "./errors";

export { StringInterner, StringReader, stringTable } from "./strings";

export {
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
    BucketArrayBuilder,
    BucketArrayReader,
    HashLookupBuilder,
    HashLookupReader,
    KeyedIndexBuilder,
    KeyedIndexReader,
    MultiBucketArrayBuilder,
    NumArrayBuilder,
    PairIndexBuilder,
    PairIndexReader,
    RawBytesBuilder,
    SingleStringRefBuilder,
    SortedU32IndexBuilder,
    SortedU32IndexReader,
    StringRefArrayBuilder,
    TrigramIndexBuilder,
    TrigramIndexReader,
    type MultiBucketArrayReader,
} from "./fields";

export {
    assertNumericRange,
    f32,
    f64,
    i8,
    i16,
    i32,
    i32Pair,
    numColumn,
    stringRef,
    u8,
    u16,
    u32,
    type ColumnReadValue,
    type ColumnSpec,
    type Columns,
    type ColumnView,
    type ColumnWriteValue,
    type NumColumnSpec,
    type StringRefColumnSpec,
} from "./columns";

export { fieldFromSignature } from "./registry";

export { hashString, hashStringToBigint, splitHash } from "./hash";

export type {
    AnyTypedArray,
    BuilderContext,
    Builders,
    BuilderOf,
    Field,
    FieldSection,
    ReaderContext,
    ReaderOf,
    Readers,
    SchemaShape,
    SnapshotSource,
    TypedArrayConstructor,
} from "./types";
