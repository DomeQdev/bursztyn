import { FormatError, type FieldDiff } from "./errors.ts";
import type { CompiledSchema, FieldLayout } from "./layout.ts";
import { fieldFromSignature } from "./registry.ts";
import { STRING_TABLE_SIGNATURE, StringReader } from "./strings.ts";
import type { AnyTypedArray, ReaderContext, Readers, SchemaShape, SnapshotSource } from "./types.ts";

// [0..4)   magic "BRSZ"          [4..6)   format version   [6..8)   flags
// [8..16)  schema hash u64       [16..20) schema version   [20..24) section count
// [24..28) manifest offset       [28..32) manifest length
// then     section table: sectionCount × (offset u32, length u32)
// then     manifest json, then payload — every section 8-byte aligned
export const MAGIC = 0x5a535242;
export const FORMAT_VERSION = 1;
export const FIXED_HEADER_BYTES = 32;

const SECTION_ALIGN = 8;
const alignUp = (n: number) => (n + (SECTION_ALIGN - 1)) & ~(SECTION_ALIGN - 1);

// Both are stateless and were being constructed per call — readHeader() runs on
// every read, migration step and inspect.
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export interface ManifestEntry {
    name: string;
    signature: string;
    sectionCount: number;
}

export interface SnapshotHeader {
    formatVersion: number;
    schemaHash: bigint;
    schemaVersion: number;
    manifest: ManifestEntry[];
    sectionTable: Uint32Array;
    bytes: Uint8Array;
}

export const toBytes = (source: SnapshotSource): Uint8Array => {
    if (source instanceof Uint8Array) return source;
    return new Uint8Array(source);
};

export interface EmittedField {
    name: string;
    signature: string;
    sections: Uint8Array[];
}

export const assembleSnapshot = (
    fields: EmittedField[],
    schemaHash: bigint,
    schemaVersion: number,
    allocate: (byteLength: number) => ArrayBufferLike = (byteLength) => new ArrayBuffer(byteLength),
): Uint8Array => {
    const manifest: ManifestEntry[] = fields.map(({ name, signature, sections }) => ({
        name,
        signature,
        sectionCount: sections.length,
    }));

    const manifestBytes = ENCODER.encode(
        JSON.stringify(manifest.map((e) => [e.name, e.signature, e.sectionCount])),
    );

    let sectionCount = 0;
    for (const field of fields) sectionCount += field.sections.length;

    const manifestOffset = FIXED_HEADER_BYTES + sectionCount * 8;
    const sectionTable = new Uint32Array(sectionCount * 2);

    let offset = alignUp(manifestOffset + manifestBytes.byteLength);
    let sectionId = 0;

    for (const field of fields) {
        for (const section of field.sections) {
            offset = alignUp(offset);
            sectionTable[sectionId * 2] = offset;
            sectionTable[sectionId * 2 + 1] = section.byteLength;
            offset += section.byteLength;
            sectionId++;
        }
    }

    if (offset > 0xffffffff) {
        throw new FormatError(`Snapshot is ${offset} bytes; the section table addresses at most 4 GiB.`);
    }

    const bytes = new Uint8Array(allocate(offset));
    const view = new DataView(bytes.buffer);

    view.setUint32(0, MAGIC, true);
    view.setUint16(4, FORMAT_VERSION, true);
    view.setUint16(6, 0, true);
    view.setBigUint64(8, BigInt.asUintN(64, schemaHash), true);
    view.setUint32(16, schemaVersion, true);
    view.setUint32(20, sectionCount, true);
    view.setUint32(24, manifestOffset, true);
    view.setUint32(28, manifestBytes.byteLength, true);

    bytes.set(new Uint8Array(sectionTable.buffer), FIXED_HEADER_BYTES);
    bytes.set(manifestBytes, manifestOffset);

    sectionId = 0;
    for (const field of fields) {
        for (const section of field.sections) {
            bytes.set(section, sectionTable[sectionId * 2]);
            sectionId++;
        }
    }

    return bytes;
};

export const readHeader = (source: SnapshotSource): SnapshotHeader => {
    const bytes = toBytes(source);

    if (bytes.byteLength < FIXED_HEADER_BYTES) {
        throw new FormatError(`Not a bursztyn snapshot: only ${bytes.byteLength} bytes.`);
    }
    if (bytes.byteOffset % SECTION_ALIGN !== 0) {
        throw new FormatError(
            `Snapshot view must start at an 8-byte aligned offset (got ${bytes.byteOffset}).`,
        );
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC) {
        throw new FormatError("Not a bursztyn snapshot: bad magic.");
    }

    const formatVersion = view.getUint16(4, true);
    if (formatVersion !== FORMAT_VERSION) {
        throw new FormatError(
            `Snapshot uses format version ${formatVersion}, this build reads ${FORMAT_VERSION}.`,
        );
    }

    const sectionCount = view.getUint32(20, true);
    const manifestOffset = view.getUint32(24, true);
    const manifestLength = view.getUint32(28, true);

    if (FIXED_HEADER_BYTES + sectionCount * 8 > bytes.byteLength) {
        throw new FormatError(
            `Snapshot is truncated: header claims ${sectionCount} sections but the file is ` +
                `only ${bytes.byteLength} bytes.`,
        );
    }

    const raw = JSON.parse(
        DECODER.decode(bytes.subarray(manifestOffset, manifestOffset + manifestLength)),
    ) as [string, string, number][];

    return {
        formatVersion,
        schemaHash: view.getBigUint64(8, true),
        schemaVersion: view.getUint32(16, true),
        manifest: raw.map(([name, signature, count]) => ({ name, signature, sectionCount: count })),
        // A view, not a copy. The header check above guarantees an 8-byte
        // aligned byteOffset and the table sits at a fixed 32-byte offset, so
        // it is always safely u32-aligned — opening a snapshot should not have
        // to duplicate its section table first.
        sectionTable: new Uint32Array(
            bytes.buffer,
            bytes.byteOffset + FIXED_HEADER_BYTES,
            sectionCount * 2,
        ),
        bytes,
    };
};

export const readSchemaHash = (source: SnapshotSource): bigint => readHeader(source).schemaHash;
export const readSchemaVersion = (source: SnapshotSource): number => readHeader(source).schemaVersion;

export const isSnapshot = (source: SnapshotSource): boolean => {
    const bytes = toBytes(source);
    if (bytes.byteLength < FIXED_HEADER_BYTES) return false;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === MAGIC;
};

export const layoutFromManifest = (manifest: ManifestEntry[]): FieldLayout[] => {
    const layout: FieldLayout[] = [];
    let startSectionId = 0;

    for (const entry of manifest) {
        layout.push({
            name: entry.name,
            field: fieldFromSignature(entry.signature),
            signature: entry.signature,
            startSectionId,
            sectionCount: entry.sectionCount,
        });
        startSectionId += entry.sectionCount;
    }

    return layout;
};

export const sectionBytes = (header: SnapshotHeader, sectionId: number): Uint8Array => {
    const offset = header.sectionTable[sectionId * 2];
    const length = header.sectionTable[sectionId * 2 + 1];
    return new Uint8Array(header.bytes.buffer, header.bytes.byteOffset + offset, length);
};

export const createReadersFromLayout = (
    layout: FieldLayout[],
    header: SnapshotHeader,
): Record<string, unknown> => {
    const readers: Record<string, unknown> = {};
    let strings: StringReader | undefined;

    for (const entry of layout) {
        if (entry.signature === STRING_TABLE_SIGNATURE) {
            const offsets = sectionBytes(header, entry.startSectionId);
            strings = new StringReader(
                new Uint32Array(offsets.buffer, offsets.byteOffset, offsets.byteLength / 4),
                sectionBytes(header, entry.startSectionId + 1),
            );
            readers[entry.name] = strings;
            break;
        }
    }

    if (!strings) throw new FormatError("Schema must declare exactly one stringTable() field.");

    const resolve = <T>(name: string): T => {
        const reader = readers[name];
        if (reader === undefined) throw new FormatError(`Field "${name}" is not materialised yet.`);
        return reader as T;
    };

    for (const entry of layout) {
        if (readers[entry.name] !== undefined) continue;

        const sections: Uint8Array[] = [];
        for (let i = 0; i < entry.sectionCount; i++) {
            sections.push(sectionBytes(header, entry.startSectionId + i));
        }

        const ctx: ReaderContext = {
            sections,
            view: <T extends AnyTypedArray>(
                idx: number,
                ctor: { new (b: ArrayBufferLike, o: number, l: number): T; BYTES_PER_ELEMENT: number },
            ) => {
                const bytes = sections[idx];
                return new ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / ctor.BYTES_PER_ELEMENT);
            },
            strings,
            resolve,
        };

        readers[entry.name] = entry.field.createReader(ctx);
    }

    return readers;
};

export const createReaders = <S extends SchemaShape>(
    compiled: CompiledSchema<S>,
    source: SnapshotSource,
): Readers<S> => {
    return createReadersFromLayout(compiled.layout, readHeader(source)) as Readers<S>;
};

export const diffManifest = (manifest: ManifestEntry[], layout: FieldLayout[]): FieldDiff[] => {
    const diff: FieldDiff[] = [];
    const before = new Map(manifest.map((entry, index) => [entry.name, { entry, index }]));
    const after = new Map(layout.map((entry, index) => [entry.name, { entry, index }]));

    for (const [name, { entry, index }] of after) {
        const previous = before.get(name);
        if (!previous) {
            diff.push({ kind: "added", name, signature: entry.signature });
        } else if (previous.entry.signature !== entry.signature) {
            diff.push({
                kind: "changed",
                name,
                before: previous.entry.signature,
                after: entry.signature,
            });
        } else if (previous.index !== index) {
            diff.push({ kind: "moved", name, before: previous.index, after: index });
        }
    }

    for (const [name, { entry }] of before) {
        if (!after.has(name)) diff.push({ kind: "removed", name, signature: entry.signature });
    }

    return diff;
};

export interface FieldStat {
    name: string;
    signature: string;
    sectionCount: number;
    bytes: number;
}

export interface SnapshotInfo {
    formatVersion: number;
    schemaHash: bigint;
    schemaVersion: number;
    totalBytes: number;
    fields: FieldStat[];
}

export const inspect = (source: SnapshotSource): SnapshotInfo => {
    const header = readHeader(source);
    const fields: FieldStat[] = [];
    let sectionId = 0;

    for (const entry of header.manifest) {
        let bytes = 0;
        for (let i = 0; i < entry.sectionCount; i++) {
            bytes += header.sectionTable[(sectionId + i) * 2 + 1];
        }
        sectionId += entry.sectionCount;
        fields.push({ ...entry, bytes });
    }

    return {
        formatVersion: header.formatVersion,
        schemaHash: header.schemaHash,
        schemaVersion: header.schemaVersion,
        totalBytes: header.bytes.byteLength,
        fields,
    };
};
