# AGENTS.md

`bursztyn-db` — zero-copy columnar snapshots for TypeScript, with generated migrations. The package is
`bursztyn-db`; the CLI command is `bursztyn`.

Two halves. Read the one that matches what you are doing:

- **[Using bursztyn in a project](#using-bursztyn-in-a-project)** — you are changing a schema, filling
  in a migration, or debugging a snapshot that will not open. Start here; this is most of the file.
- **[Working on bursztyn itself](#working-on-bursztyn-itself)** — you are editing this library's source.

`README.md` explains *why* the library is shaped this way and documents every field type. This file
is the operating manual: what to run, what to edit, and what never to touch.

---

## Using bursztyn in a project

### Shape of a bursztyn project

```
bursztyn.config.json      { "schema": "./src/schema.ts", "out": "./amber" }
src/schema.ts             your `fields`, plus defineSchema({ fields, migrations })
amber/                    the migrations folder ("out")
  index.ts                GENERATED — the bundle your schema imports
  0001_add_stop_bearing.ts    one file per version — the only files you edit
  meta/
    _journal.json         GENERATED — the ordered list of versions
    0000_snapshot.json    GENERATED — the schema as it was at each version
    0001_snapshot.json
*.brsz                    snapshots — build artifacts, not source
```

Before changing anything, find out where the project stands:

```
bursztyn status           # per-schema check; exits non-zero if anything needs attention
```

The CLI has to import the schema module, so a `.ts` schema needs Bun, Deno, or Node >= 22.18. The
binary starts under Node and re-runs itself under `bun` from PATH if Node cannot load the module.

### The one rule

**Generated files are generated.** Inside `amber/` you edit exactly three things, all in a migration
file (`NNNN_*.ts`):

1. the body of `up()`,
2. the `pending` array — you *delete names from* it,
3. `rebuilds`, when you need to take over a field that would otherwise be carried.

Everything else — `index.ts`, `meta/*.json`, and a migration's `id` / `defines` / `renames` /
`drops` — was written to match a recorded diff. The CLI diffs your schema against `meta/`, so
editing `meta/` makes the next `generate` describe a change that never happened, and editing
`index.ts` only desynchronises it from the journal that regenerates it.

### The loop

1. Edit `fields` in the schema module. **Do not touch `version`** — with a generated bundle
   `defineSchema` throws if `version` is present at all.
2. Run `bursztyn generate` (add `--only <name>` when the project has several schemas).
3. If the output says *"N fields need data"*, open the file it names. For each `todo("x")`:
   replace it with code that fills the field (or delete it — see
   [pending but nothing to do](#when-a-field-is-pending-but-nothing-needs-doing)), then delete `"x"`
   from `pending`. Delete the whole `pending: [...]` line once it is empty.
4. `bursztyn status` — must report every schema up to date and exit 0.
5. Run the project's tests. A test that opens an old fixture through
   `schema.open(bytes, { migrate: true })` is what actually exercises the migration; `status` only
   checks that the chain is complete.

`generate` exits non-zero while anything is still `pending`, and `defineSchema` throws at import
until `pending` is empty — a half-finished migration cannot start the app or pass CI.

### What kind of change is this?

| Change to `fields` | The CLI writes | You write |
| --- | --- | --- |
| Add a field | `defines: { x: … }` + `pending: ["x"]` | `up()` that fills `x`, then clear `pending` |
| Remove a field | `drops: ["x"]` | nothing — `generate` exits 0 |
| Rename a field | `renames: { old: "new" }` | nothing — the bytes are carried |
| Change a field's type | `defines: { x: <new ctor> }` + `pending: ["x"]` | `up()` that recomputes `x` from `previous` |
| Reorder fields | a migration with nothing in it | nothing — but it still costs a version |
| Same layout, new *meaning* | **nothing at all** | see below |

**The last row is the trap.** The schema hash covers each field's name, signature, section span and
position — not what its values mean. Switching `stopLat` from metres to centimetres, or changing how
a `trigramIndex` gets populated, produces no diff, no migration and no error: old snapshots keep
loading, with stale values. There is no "empty migration" escape hatch in the CLI. Either

- rebuild the snapshot from source (the normal answer — snapshots are build artifacts), or
- make the change visible in the layout so the tooling can see it: rename the field to its new
  meaning (`stopLatM` → `stopLatCm`) and treat it as **drop + add**, which gives you a `pending`
  slot to convert the old values in. See the next section for how to get drop + add without a TTY.

### Renames, and how to avoid the interactive prompt

A field that disappears while another appears with the same signature is ambiguous — rename, or drop
plus add? The CLI asks:

```
? Is stopName renamed to stopLabel (both stringRefArray)? [y/N]
```

**Outside a TTY it refuses and exits 1.** An agent running non-interactively has two ways through:

- It *is* a rename → `bursztyn generate --rename stopName=stopLabel` (with `--only <name>` if the
  project has several schemas — `--rename` and `--name` both require it).
- It is *not* a rename, and you want the old values converted into the new field → **split it across
  two `generate` runs, add first**:

  1. Add `stopLatCm` while `stopLatM` is still in `fields`. Only an addition, so nothing is
     ambiguous. Fill `up()` by reading `previous.get<Int32Array>("stopLatM")` and converting.
  2. Now remove `stopLatM` and generate again. Only a removal, so nothing is ambiguous, and the CLI
     writes the whole `drops` migration itself.

  Doing it in the other order loses the data: once step 1 has dropped the field, step 2's `previous`
  no longer has it to read from.

### Writing `up()`

```ts
up({ previous, builders, strings, carried, log }) { … }
```

| Name | Is |
| --- | --- |
| `previous` | The **input** snapshot, read generically: `get<T>(name)` (throws if absent), `tryGet<T>`, `has`, `signature`, `names`, `strings`, `version`. Names are the **old** ones — a field renamed by this step is still under its old name here. |
| `builders` | The output builders, typed from your schema. Unknown names stay open, because a mid-chain step may touch fields the current schema no longer has. |
| `strings` | The interner, hydrated from the old string table. Existing ids stay valid, so every carried `stringRefArray` keeps resolving; `strings.add(s)` appends and returns an id. |
| `carried` | `Set` of the fields copied over untouched. |
| `log` | The `log` callback passed to `migrate()`, if any. |

Rules the library enforces, so follow them deliberately:

- **Only write fields listed in `defines` or `rebuilds`.** Everything a migration does not mention is
  memcpy'd from the old snapshot. Writing to a carried field throws `CarryConflictError` instead of
  silently discarding the write — if you really do need to recompute it, add it to `rebuilds`.
- **Never rebuild the string table by hand.** Use `strings` / `pushString`; ids must stay stable.
- **Push exactly one value per entity** into a new parallel column, in the same order as the column
  you are deriving it from. Nothing checks the count for you, and a short column silently misaligns
  every index built over it.
- **Read from `previous`, don't recompute from source data.** Migrating a large snapshot is supposed
  to cost about what copying it costs. Re-deriving a field from the original CSV inside `up()`
  throws that away — if that is genuinely what you want, rebuild the snapshot instead.
- `up` may be `async`.

A field that had bytes before and none after is a `MigrationDataLossError` unless you listed it in
`drops` — so an `up()` that forgets to fill something fails loudly rather than shipping a hole.

#### Builder cheat sheet

What to call inside `up()`, and in any snapshot builder:

| Field | Write with |
| --- | --- |
| `stringTable()` | `strings.add(s)` returns an id — never build it directly |
| `singleStringRef()` | `.set(s)` |
| `stringRefArray()` | `.pushString(s)` or `.pushId(id)` |
| `numArray(Ctor)` | `.push(n)`, `.pushMany(arr)`, `.setFrom(arr)` |
| `rawBytes()` | `.set(u8)` |
| `bucketArray(spec)` | `.addBucket([…])`, or `.push(v)` … `.endBucket()` |
| `multiBucketArray({…})` | `.addBucket([{col: v}, …])`, or `.push({col: v})` … `.endBucket()` |
| `hashLookup({ verifyVia })` | `.add(key, rowIndex)` |
| `keyedIndex(spec)` | `.add(key, values)` |
| `pairIndex({…})` | `.add(a, b, {col: v})` |
| `sortedU32Index()` | `.add(key, value)` |
| `trigramIndex()` | `.addEntry(rowIndex, name)` |

Every bucket-shaped builder needs one bucket per entity, in entity order — `addBucket([])` for an
empty one. Skipping a bucket shifts every later row.

```ts
// 0001_add_stop_bearing.ts — filled in
export default migration({
    id: "0001_add_stop_bearing",
    defines: { stopBearing: numArray(Uint16Array) },
    up({ previous, builders }) {
        const lat = previous.get<Int32Array>("stopLat");
        const lon = previous.get<Int32Array>("stopLon");
        for (let i = 0; i < lat.length; i++) {
            builders.stopBearing.push(bearingOf(lat[i], lon[i]));
        }
    },
});
```

#### When a field is `pending` but nothing needs doing

Sometimes the CLI marks a field as needing data when the migration will in fact carry it. The common
case is an index whose signature names another field: `hashLookup({ verifyVia: "stopId" })` has the
signature `hashLookup:stopId`, so renaming `stopId` changes the lookup's signature too, and the CLI
puts the lookup in `defines` and `pending` alongside the rename.

At migrate time the rename is applied to the signature before the carry check, so the lookup is
carried unchanged and needs no code at all. **Delete the `todo()` and the name from `pending`, and
write nothing.** Rebuilding it by hand instead gets you a `CarryConflictError`, which is the library
telling you the same thing.

### Reading snapshots at runtime

```ts
schema.read(bytes);                                   // strict — throws SchemaMismatchError on any drift
await schema.open(bytes, { migrate: true });          // { readers, bytes, report }
await schema.migrate(bytes, { log, shared });         // { bytes, report } — just the upgrade
await openSnapshotFile(schema, path, { migrate: true, writeBack: true });
schema.matches(bytes);                                // boolean, never throws
schema.diff(bytes);                                   // FieldDiff[] — what changed
```

`open()` migrates by default; pass `migrate: false` to make an old snapshot an error instead.
`writeBack: true` persists the migrated bytes back over the file. `report.migrated` is `false` when
the snapshot was already current, and each `report.steps[i]` lists `carried` / `rebuilt` / `added` /
`dropped` / `renamed` plus `bytesBefore` / `bytesAfter`.

Migrations only run **forward**. A snapshot written by a newer build than the one reading it is a
`MigrationPathError`, never a bad read.

### Errors, and what each one means you should do

**At import (the app refuses to start):**

| Error | Fix |
| --- | --- |
| `SchemaDriftError` — "Your schema has changes that are not in a migration" | Run `bursztyn generate` (`--only <name>` if it names one). Do **not** delete `amber/` or edit `index.ts`. |
| `UnfinishedMigrationError` — "these fields are still placeholders" | Fill in `up()` in the named file, then delete those names from `pending`. |
| `MissingMigrationsError` — "no migrations have been generated yet" | Run `bursztyn generate` once; it initialises the folder at version 0. |
| "`version` is managed by the bursztyn CLI" | Remove `version:` from `defineSchema()`. The bundle owns it. |
| "A schema needs exactly one `stringTable()` field" | Add one, or remove the duplicate. |
| "The last migration lands on version N but the schema declares M" | Hand-written `migrations` array only — the chain does not reach the declared version. |

**While migrating:**

| Error | Fix |
| --- | --- |
| `MigrationDataLossError` | A field that had bytes has none now. Fill it in `up()`, or list it in `drops` to confirm the loss is intended. |
| `CarryConflictError` | You wrote to an auto-carried field. Either drop the code (it was already carried) or add the field to `rebuilds`. |
| `MigrationPathError` | A gap in the chain, or a snapshot newer than this build. Migrations never run backwards. |
| "does not land on the current schema" | The named field is in the schema but nothing creates it (add to `defines`), or survives but is not in the schema (add to `drops` or `renames`). |
| `Migration placeholder for "x" was never filled in` | A `todo()` is still in `up()` — you cleared `pending` without writing the code. |
| `RangeError` naming a field at a `push` | The value overflows that typed array. Widen the field — itself a schema change, and a migration — or clamp the value. |

**When reading:**

| Error | Fix |
| --- | --- |
| `SchemaMismatchError` | The snapshot predates this build. Use `open(bytes, { migrate: true })`, or rebuild it. The message prints the field-level diff. |
| `UnknownSignatureError` | Written by a newer bursztyn, or by a custom field type this build does not register. |
| `FormatError: … ended after N of M bytes` | Truncated file. |

**From the CLI:**

| Message | Fix |
| --- | --- |
| "Ambiguous change: X disappeared and Y appeared" | `--rename X=Y`, or use the two-step split above. Outside a TTY it will not guess. |
| "`--name` and `--rename` apply to one schema" | Add `--only <name>`. |
| "exports N schemas" | Add `--export <name>`, or give each one an entry in `schemas`. |
| "Could not import … Node cannot import TypeScript" | Run under Bun or Node >= 22.18, or point `schema` at a `.js` module. |
| "`./bursztyn-db` has the same name as the package or its CLI" | `out` shadows the package (`bursztyn-db`) for bare specifiers, or the CLI (`bursztyn`) for `bun bursztyn`. Rename it; `./amber` is the default. |

### Several schemas

```json
{ "schemas": ["./src/stops.ts", "./src/routes.ts"], "out": "./amber" }
```

Each schema gets its own subfolder, journal and version numbers — nothing is shared, and adding a
field to one leaves the other where it was. The name comes from the filename, falling back to the
folder for a generic one (`src/routes/schema.ts` → `routes`); `{ "schema": "…", "name": "…" }`
overrides it. `--only <name>` narrows a run and is required by `--name` and `--rename`. Runtime
refusals name the schema, so the command they suggest is always one you can paste.

### CI

`bursztyn status` exits non-zero on drift, on unfinished placeholders, and on an empty folder — run
it alongside the type check. It is also the fastest way to confirm that a schema change is actually
finished.

### Never do this

- **Never delete `amber/`, or a file in `meta/`, to make an error go away.** The journal is the only
  record of how existing snapshots reach the current schema; regenerating from scratch makes every
  snapshot in the wild unmigratable, and the error was telling you to run one command.
- **Never edit `meta/*.json` or `amber/index.ts`** to make a hash match.
- **Never set `enforcement.enabled = false`.** It is the CLI's own switch for loading a drifted
  schema; using it in an app disables all three import-time refusals.
- **Never delete a name from `pending` without replacing its `todo()`** — that moves a hard
  import-time error to a runtime one in the middle of a migration.
- **Never renumber, reorder, squash or rewrite migrations that have shipped.** Version numbers are
  positions in the journal, and a snapshot in the wild is sitting at one of them.
- **Never add `version:` back** to a `defineSchema()` that has a generated bundle.
- **Never "fix" a `SchemaMismatchError` by catching it and rebuilding silently.** If a fallback is
  the right call for the project, make it explicit where it happens.

---

## Working on bursztyn itself

```
bun test                  # 122 tests across 13 files
bun run typecheck         # tsc --noEmit
bun run build             # tsc -p tsconfig.build.json → dist/
```

Zero runtime dependencies, and it stays that way. The library targets Bun, Node 18+, Deno and
browsers; only `io.ts` and the CLI (`cli.ts`, `cli/`) touch `node:` modules — `io.ts` behind a
dynamic import, so the library entry never pulls them in.

### Where things live

| File | Holds |
| --- | --- |
| `types.ts` | The `Field` interface every field type implements, and the `Builders`/`Readers` mapped types. |
| `layout.ts` | `compileSchema` — assigns section ids and computes the schema hash. |
| `format.ts` | Binary header, section table, manifest, `assembleSnapshot`, `diffManifest`, reader construction. |
| `builder.ts` | `SnapshotBuilder` — per-field builders, `carry()` for raw sections, `build()`/`buildShared()`. |
| `fields/` | One file per field family — `flat.ts` (`numArray`, `stringRefArray`, `singleStringRef`, `rawBytes`), `hashLookup.ts`, `trigramIndex.ts`, `sortedU32Index.ts`, `bucketArray.ts` (plus `multiBucketArray`), `keyedIndex.ts`, `pairIndex.ts` — each holding its builder, reader and `Field`. `fields/index.ts` re-exports them. |
| `columns.ts` | Column specs (`u8()` … `stringRef()`) shared by the bucket and index families. |
| `strings.ts` | `StringInterner` (write), `StringReader` (read), `stringTable()`. |
| `utf8.ts` | Byte-level helpers the string table dedupes and verifies with, without decoding anything. |
| `registry.ts` | `fieldFromSignature` — signature string to field instance. How a snapshot is read without its schema. |
| `schema.ts` | `defineSchema`, the three import-time refusals, `read` / `open` / `migrate`. |
| `migrate.ts` | Chain resolution, per-step auto-carry, and the guardrails (`CarryConflictError`, the data-loss check). |
| `bundle.ts` | `defineMigrations` — what `amber/index.ts` calls — and the drift / unfinished errors. |
| `generate.ts` | Pure planning: diff → `SchemaChange` → the text of every generated file. |
| `journal.ts` | Journal and per-version snapshot shapes, and the paths they live at. |
| `config.ts` | `bursztyn.config.json` → targets, including name derivation and collision checks. |
| `cli.ts` | The bin entry: usage text and command dispatch. |
| `cli/` | `terminal.ts` (argv, colours, output), `load.ts` (config, schema module, the Bun re-exec, journal), and one file per command: `generate.ts`, `status.ts`, `inspect.ts`. |
| `io.ts` | File helpers, including the unzeroed-buffer read and the header-only read. |

### Compatibility contract

Two things are load-bearing for every snapshot ever written:

1. **Signature strings** (`num:Int32Array`, `hashLookup:stopId`, `bucketArray:Uint32Array:1`, …).
   They go into the manifest and into `fieldFromSignature`. Changing one orphans existing snapshots.
   When a field type's meaning has to change, add a new signature and keep the old one readable —
   `pairIndex2` / `pairIndexLegacy` is the worked example.
2. **The hash inputs** in `compileSchema` (`name:signature:startSection:sectionCount`, summed).
   Changing the formula invalidates every recorded hash in every `meta/` folder in the world.

The binary layout itself is versioned by `FORMAT_VERSION` in `format.ts`.

### Adding a field type

1. Implement builder, reader and `Field` in a file under `fields/`, next to its closest relative, and
   re-export it from `fields/index.ts`. `signature()` must encode everything that affects the layout.
2. Register the signature in `registry.ts` so snapshots can be read without a schema — migrations
   depend on this.
3. Teach `renderField` in `generate.ts` to emit a constructor call for it, or generated migrations
   fall back to `fieldFromSignature("…")` — which works, but reads badly in a file a human has to edit.
4. Export it from `index.ts`.
5. Test the round trip in a `fields/<name>.test.ts` beside it, and a carry through a migration in
   `migrate.test.ts`.

### Conventions

Four-space indent. Relative imports carry the `.ts` extension (`allowImportingTsExtensions` plus
`rewriteRelativeImportExtensions`). Helpers are `const` arrow functions; builders and readers are
classes. Errors subclass `BursztynError` and state the fix in the imperative — the error text *is*
the documentation for whoever hits it, and several tests assert on it. Comments explain why a thing
is the way it is, not what the line does; match the existing density.
