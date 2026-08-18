export { defineSchema, migration, Schema } from "./schema.ts";
export type { OpenOptions, OpenResult, SchemaDefinition } from "./schema.ts";

export {
    defineMigrations,
    generateCommand,
    isBundle,
    todo,
    MissingMigrationsError,
    SchemaDriftError,
    UnfinishedMigrationError,
    type MigrationBundle,
    type MigrationBundleInput,
} from "./bundle.ts";

export {
    ConfigError,
    DEFAULT_IMPORT_FROM,
    DEFAULT_OUT,
    deriveName,
    resolveTargets,
    type ConfigFile,
    type Overrides,
    type Target,
    type TargetInput,
} from "./config.ts";

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
} from "./generate.ts";

export {
    emptyJournal,
    parseJournal,
    snapshotManifest,
    type Journal,
    type JournalEntry,
    type SchemaSnapshot,
} from "./journal.ts";

export { SnapshotBuilder } from "./builder.ts";

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
} from "./migrate.ts";

export {
    assembleSnapshot,
    createReaders,
    createReadersFromHeader,
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
} from "./format.ts";

export { compileSchema, type CompiledSchema, type FieldLayout } from "./layout.ts";

export {
    openSnapshotFile,
    readSnapshotFile,
    readSnapshotHeaderFile,
    writeSnapshotFile,
    type OpenFileOptions,
    type ReadFileOptions,
} from "./io.ts";

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
} from "./errors.ts";

export { StringInterner, StringReader, stringTable } from "./strings.ts";

export {
    bucketArray,
    hashLookup,
    keyedIndex,
    multiBucketArray,
    numArray,
    pairIndex,
    pairIndexLegacy,
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
} from "./fields.ts";

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
} from "./columns.ts";

export { fieldFromSignature } from "./registry.ts";

export { fmix32, hashString, hashStringToBigint, splitHash } from "./hash.ts";

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
} from "./types.ts";
