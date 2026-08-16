export { defineSchema, migration, Schema } from "./schema.js";
export type { OpenOptions, OpenResult, SchemaDefinition } from "./schema.js";

export {
    defineMigrations,
    isBundle,
    todo,
    MissingMigrationsError,
    SchemaDriftError,
    UnfinishedMigrationError,
    type MigrationBundle,
    type MigrationBundleInput,
} from "./bundle.js";

export {
    describeChange,
    isEmptyChange,
    planGeneration,
    renameCandidates,
    renderField,
    suggestName,
    type GeneratedFile,
    type GenerateOptions,
    type GenerateResult,
    type SchemaChange,
} from "./generate.js";

export {
    emptyJournal,
    parseJournal,
    snapshotManifest,
    type Journal,
    type JournalEntry,
    type SchemaSnapshot,
} from "./journal.js";

export { SnapshotBuilder } from "./builder.js";

export {
    migrateSnapshot,
    resolveChain,
    type MigrateOptions,
    type Migration,
    type MigrationContext,
    type MigrationReport,
    type MigrationStep,
    type MigrationStepReport,
    type MigrationTarget,
    type PreviousSnapshot,
} from "./migrate.js";

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
} from "./format.js";

export { compileSchema, type CompiledSchema, type FieldLayout } from "./layout.js";

export {
    openSnapshotFile,
    readSnapshotFile,
    writeSnapshotFile,
    type OpenFileOptions,
    type ReadFileOptions,
} from "./io.js";

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
} from "./errors.js";

export { StringInterner, StringReader, stringTable } from "./strings.js";

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
} from "./fields.js";

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
} from "./columns.js";

export { fieldFromSignature } from "./registry.js";

export { hashString, hashStringToBigint, splitHash } from "./hash.js";

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
} from "./types.js";
