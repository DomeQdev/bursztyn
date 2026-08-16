# bursztyn

Zero-copy, single-buffer columnar snapshots for TypeScript — with a migration system.

You describe your data once as a **schema of typed-array fields**. bursztyn compiles it into a single
flat buffer: one `ArrayBuffer` (or `SharedArrayBuffer`) you can hand to a worker, `mmap`, or write to
disk. Reading is not deserialization — the readers are typed-array views straight into that buffer, so
opening a 300 MB snapshot costs nothing but the read.

Data, frozen in amber. `bursztyn` is Polish for amber.

```
npm install bursztyn
```

## Why

Structured data that is written rarely and read constantly — a compiled timetable, a geocoding index,
a game's static content, an ML feature table — does not want JSON, and does not want SQLite either.
It wants to be *already in memory, in the right shape*, the moment the process starts.

That is what a bursztyn snapshot is:

- **No parse step.** `schema.read(buffer)` walks a section table and hands back typed arrays. Microseconds, not seconds.
- **Shareable.** Build into a `SharedArrayBuffer` and every worker reads the same bytes. No structured clone, no per-thread copy.
- **Compact.** Columnar layout, interned strings, `Uint8Array` where a byte will do.
- **Versioned.** The schema hashes itself, so a snapshot written by an older build is detected, not misread.
- **Migratable.** And when it *is* older, a declared migration chain upgrades it in place instead of forcing a full rebuild from source.

No dependencies. Works on Bun, Node 18+, Deno and in browsers (file helpers aside).

## Quick start

```ts
import {
    bucketArray, defineSchema, hashLookup, numArray,
    singleStringRef, stringRefArray, stringTable, u32,
} from "bursztyn";

const schema = defineSchema({
    version: 1,
    fields: {
        strings: stringTable(),                       // every schema needs exactly one
        city: singleStringRef(),
        stopLookup: hashLookup({ verifyVia: "stopId" }),
        stopId: stringRefArray(),
        stopName: stringRefArray(),
        stopLat: numArray(Int32Array),
        stopRoutes: bucketArray(u32()),               // variable-length list per stop
    },
});
```

Write:

```ts
const builder = schema.builder();

builder.builders.city.set("warsaw");
builder.builders.stopId.pushString("R-ONZ");
builder.builders.stopName.pushString("Rondo ONZ");
builder.builders.stopLookup.add("R-ONZ", 0);
builder.builders.stopLat.push(52_232_600);
builder.builders.stopRoutes.addBucket([10, 17, 33]);

await writeSnapshotFile("stops.brsz", builder.build());
```

Read:

```ts
const readers = schema.read(await readSnapshotFile("stops.brsz"));

const index = readers.stopLookup.find("R-ONZ")!;      // 0
readers.strings.get(readers.stopName[index]);         // "Rondo ONZ"
readers.stopLat[index];                               // 52232600  (Int32Array — a real view)
readers.stopRoutes.slice(index);                      // Uint32Array [10, 17, 33]
```

`readers` is fully typed from the schema. `stopLat` really is an `Int32Array` pointing into the
snapshot; there is no intermediate object anywhere.

## Fields

Every field is a column, or a small index over columns. Pick the narrowest type that fits — the
builder throws a `RangeError` naming the field and the offending value if something overflows.

| Field | Reader | For |
| --- | --- | --- |
| `stringTable()` | `StringReader` | Required once. Interns every string in the snapshot. |
| `singleStringRef()` | `string` | One string, resolved eagerly. |
| `stringRefArray()` | `Uint32Array` | A column of string ids — `strings.get(ids[i])`. |
| `numArray(Ctor)` | that typed array | A plain numeric column. |
| `rawBytes()` | `Uint8Array` | Opaque bytes (a serialized spatial index, a bitmap…). |
| `bucketArray(spec)` | `BucketArrayReader` | A variable-length list per entity, CSR-style. |
| `multiBucketArray({…})` | columns + `ptr` | Same, with several parallel columns per item. |
| `hashLookup({ verifyVia })` | `HashLookupReader` | `string → index`, open addressing. |
| `keyedIndex(spec)` | `KeyedIndexReader` | `string → list`. |
| `pairIndex({…})` | `PairIndexReader` | `(u32, u32) → row`. |
| `sortedU32Index()` | `SortedU32IndexReader` | `u32 → u32`, binary search. |
| `trigramIndex()` | `TrigramIndexReader` | Fuzzy name search, scored by trigram overlap. |

Column specs for the bucket/index families: `u8() u16() u32() i8() i16() i32() f32() f64()`,
`i32Pair()` (stride 2, e.g. a coordinate), `stringRef()`, or `numColumn(Ctor, stride)` for anything else.

```ts
stopEntrances: multiBucketArray({
    name: stringRef(),
    location: i32Pair(),      // [lon, lat]
}),
```

`hashLookup({ verifyVia: "stopId" })` stores only 64-bit hashes — no keys. `verifyVia` names a
`stringRefArray` field to re-check the hit against, so a collision returns `undefined` rather than
the wrong row. Omit it if your keys are known-unique and you would rather not pay the check.

## Sharing across threads

```ts
const shared = schema.builder().buildShared();        // SharedArrayBuffer, assembled in place
worker.postMessage(shared);                           // no copy

// in the worker
const readers = createReaders(schema.compiled, shared);
```

Readers hold views, never copies, so N workers reading a 1 GB snapshot cost 1 GB total. The snapshot
is immutable by construction: builders exist only before `build()`.

## Migrations

A schema hash covers every field's name, type, section span and position. Change anything and old
snapshots stop matching — which is what you want, because misreading them silently would be worse.
But "stop matching" should not mean "rebuild everything from source". Bump the version and say what
changed:

```ts
const schema = defineSchema({
    version: 2,
    fields: { ...v1Fields, stopSearch: trigramIndex() },
    migrations: [
        migration({
            from: 1,
            to: 2,
            description: "build the stop name search index",
            defines: ["stopSearch"],
            up({ previous, builders }) {
                const names = previous.get<Uint32Array>("stopName");
                for (let i = 0; i < names.length; i++) {
                    builders.stopSearch.addEntry(i, previous.strings.get(names[i]));
                }
            },
        }),
    ],
});

const { readers, report } = await openSnapshotFile(schema, "stops.brsz", {
    migrate: true,
    writeBack: true,     // persist the upgraded snapshot
});
```

**Everything you did not mention is carried over as raw bytes.** The migration above touches one
field; the other six are memcpy'd from the old snapshot without being decoded or rebuilt. That is the
whole point — migrating a large snapshot costs roughly what copying it costs.

String ids survive too. The old string table is rehydrated as the base of the new one, so ids stay
stable and every carried `stringRefArray` keeps resolving. Add new strings in `up()` and they append.

### The migration spec

| Key | Means |
| --- | --- |
| `from` / `to` | Version edge. Chains resolve automatically: 1→2→3 runs both steps. |
| `description` | Shown in logs and in the report. |
| `defines` | Fields whose definition is new or changed at this version. `["stopSearch"]` takes the definition from the current schema; `{ stopLat: numArray(Float64Array) }` states it explicitly (needed only if the field changes *again* later). |
| `renames` | `{ oldName: "newName" }` — carried raw, no rebuild. |
| `drops` | Fields intentionally removed, or intentionally left empty. |
| `rebuilds` | Fields whose type is unchanged but whose contents must be recomputed; opts them out of auto-carry. |
| `up(ctx)` | Fills anything `defines` / `rebuilds` introduced. May be async. |

Inside `up`, `ctx.previous` reads the *input* snapshot generically (`get`, `tryGet`, `has`,
`signature`, `names`, `strings`), `ctx.builders` writes the output, `ctx.strings` is the interner,
and `ctx.carried` tells you which fields came across untouched.

`ctx.builders` is typed from your schema when the migration is written inline in `defineSchema`, so
`builders.stopSearch.addEntry(i, name)` is checked like any other code — while unknown names stay
open, because a mid-chain step can touch fields the current schema no longer has. The `migration()`
helper is only there for pulling migrations out into their own files.

### It refuses to guess

Most migration systems fail by silently producing a valid-looking file with a hole in it. bursztyn
would rather not start:

- **Your chain is checked against your schema at import time.** Forget a step and `defineSchema`
  throws — *"the last migration lands on version 2 but the schema declares version 3"*, or names the
  gap in the chain.
- **Your chain is checked against the actual snapshot when it runs.** If the final step does not land
  exactly on the current schema you get the field name and the fix:
  *"`stopBearing` is in the schema but no migration creates it — add it to `defines`"*,
  *"`stopRoutes` survives the migration but is not in the schema — add it to `drops` or `renames`"*.
- **Silent data loss throws.** A field that had bytes before and none after is a
  `MigrationDataLossError` unless you listed it in `drops`.
- **Writing to a carried field throws.** Your writes would have been discarded, so you get a
  `CarryConflictError` pointing at `rebuilds` instead.
- **A missing path throws.** No migration starting at the snapshot's version, or a snapshot newer
  than the build, is a `MigrationPathError` — never a bad read.

And when a snapshot simply does not match, `SchemaMismatchError` prints the diff:

```
Snapshot schema does not match this build (snapshot 8123…, expected 4471…).
  ~ stopLat: num:Int32Array -> num:Float64Array
  + stopBearing (num:Uint16Array)
  - stopClickhouseId (num:Uint32Array)
Snapshot is at version 2, this build is at 3. Use open(source, { migrate: true }) to run the migration chain.
```

### The report

```ts
const { report } = await schema.migrate(bytes);

report.migrated;                  // false if the snapshot was already current
report.steps[0].carried;          // ["stopId", "stopName", "stopRoutes", …]
report.steps[0].rebuilt;          // ["stopLat"]
report.steps[0].added;            // ["stopBearing"]
report.steps[0].bytesBefore;      // and bytesAfter
```

## Snapshots describe themselves

Every snapshot embeds a manifest: each field's name, signature and section count. So you can open one
without the schema that wrote it — which is how migrations read old data, and how tooling works:

```ts
const header = readHeader(bytes);
const readers = createReadersFromLayout(layoutFromManifest(header.manifest), header);
readers.stopName;                 // works, untyped
```

Same trick from the shell, when you want to know what is eating your snapshot:

```
$ bursztyn inspect stops.brsz

stops.brsz
  format v1  schema v2  hash 2945778429464777919
  1.75 KiB across 8 fields

  stopSearch  1.04 KiB   59.2%  trigramIndex
  strings         97 B    5.4%  stringTable
  stopLookup      96 B    5.4%  hashLookup:stopId
  stopRoutes      40 B    2.2%  bucketArray:Uint32Array:1
  …
```

`--json` for machine output, `--sort=name|order|bytes`, `--top=N`.

## Format

```
[0..4)    magic "BRSZ"
[4..6)    format version      [6..8)   flags
[8..16)   schema hash (u64)
[16..20)  schema version      [20..24) section count
[24..32)  manifest offset + length
          section table: sectionCount × (offset u32, length u32)
          manifest (JSON)
          payload — every section 8-byte aligned
```

A field owns one or more consecutive sections (`bucketArray` owns two: `ptr` and `data`), which is
why the manifest stores section counts and why carrying a field is a plain byte copy.

Caveats worth knowing: the payload is little-endian and read through native typed arrays, so it is
not portable to a big-endian host; the section table is 32-bit, capping a snapshot at 4 GiB; and the
schema hash is stable across versions of this library but is not a checksum of your data.

## API

```ts
defineSchema({ fields, version?, migrations? })  // → Schema
schema.builder()                                 // → SnapshotBuilder
schema.read(source)                              // → typed readers, throws on mismatch
schema.open(source, { migrate })                 // → { readers, bytes, report }
schema.migrate(source, { log, shared })          // → { bytes, report }
schema.matches(source) / schema.diff(source) / schema.inspect(source)
schema.hash / schema.version / schema.compiled

builder.builders / builder.strings
builder.build()                                  // → Uint8Array
builder.buildShared()                            // → SharedArrayBuffer

readSnapshotFile(path, { shared })
writeSnapshotFile(path, bytes)
openSnapshotFile(schema, path, { migrate, writeBack, shared, log })

readHeader(source) / inspect(source) / isSnapshot(source)
layoutFromManifest(manifest) / createReadersFromLayout(layout, header)
```

## License

MIT
