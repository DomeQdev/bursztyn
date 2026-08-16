import { FormatError } from "./errors.ts";
import { FIXED_HEADER_BYTES } from "./format.ts";
import type { OpenOptions, OpenResult, Schema } from "./schema.ts";
import type { SchemaShape } from "./types.ts";

export interface ReadFileOptions {
    shared?: boolean;
}

const HAS_BUFFER = typeof Buffer !== "undefined";

/**
 * `size` bytes about to be overwritten in full.
 *
 * `new ArrayBuffer` is specified to hand back zeroed memory, so a plain
 * allocation touches every page once before the read touches it again — on a
 * 300 MB snapshot that is 300 MB of pointless writes. `allocUnsafeSlow` skips
 * the zeroing and, unlike `allocUnsafe`, never carves out of the shared pool —
 * which matters here because a pooled Buffer starts at an arbitrary byteOffset
 * and `readHeader` requires an 8-byte aligned one.
 */
const allocate = (size: number, shared: boolean): Uint8Array => {
    if (shared) return new Uint8Array(new SharedArrayBuffer(size));
    if (!HAS_BUFFER) return new Uint8Array(size);

    const buffer = Buffer.allocUnsafeSlow(size);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, size);
};

const readInto = async (
    handle: { read: (b: Uint8Array, o: number, l: number, p: number) => Promise<{ bytesRead: number }> },
    bytes: Uint8Array,
    size: number,
    path: string,
): Promise<void> => {
    let offset = 0;
    while (offset < size) {
        const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }

    // Previously a short read left the tail zeroed and the snapshot was parsed
    // anyway. It has to be caught now that the buffer starts as whatever was in
    // memory — and a truncated snapshot was never something to read past.
    if (offset < size) {
        throw new FormatError(`${path} ended after ${offset} of ${size} bytes.`);
    }
};

export const readSnapshotFile = async (
    path: string,
    options: ReadFileOptions = {},
): Promise<Uint8Array> => {
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");

    try {
        const { size } = await handle.stat();
        const bytes = allocate(size, options.shared === true);
        await readInto(handle, bytes, size, path);
        return bytes;
    } finally {
        await handle.close();
    }
};

/**
 * Just the self-describing prefix: fixed header, section table and manifest.
 *
 * Everything `inspect` reports lives in there, so a tool that only wants to
 * know what is in a snapshot does not have to pull the payload into memory
 * behind it. `size` is the real file size, for the total the prefix cannot say.
 */
export const readSnapshotHeaderFile = async (
    path: string,
): Promise<{ bytes: Uint8Array; size: number }> => {
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");

    try {
        const { size } = await handle.stat();
        if (size < FIXED_HEADER_BYTES) {
            const bytes = new Uint8Array(size);
            await readInto(handle, bytes, size, path);
            return { bytes, size };
        }

        const fixed = new Uint8Array(FIXED_HEADER_BYTES);
        await readInto(handle, fixed, FIXED_HEADER_BYTES, path);

        const view = new DataView(fixed.buffer);
        const prefix = Math.min(size, view.getUint32(24, true) + view.getUint32(28, true));

        const bytes = new Uint8Array(Math.max(prefix, FIXED_HEADER_BYTES));
        await readInto(handle, bytes, bytes.byteLength, path);
        return { bytes, size };
    } finally {
        await handle.close();
    }
};

export const writeSnapshotFile = async (path: string, bytes: Uint8Array): Promise<void> => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, bytes);
};

export interface OpenFileOptions extends OpenOptions, ReadFileOptions {
    writeBack?: boolean;
}

export const openSnapshotFile = async <S extends SchemaShape>(
    schema: Schema<S>,
    path: string,
    options: OpenFileOptions = {},
): Promise<OpenResult<S>> => {
    const result = await schema.open(await readSnapshotFile(path, options), options);
    if (result.report.migrated && options.writeBack) await writeSnapshotFile(path, result.bytes);

    return result;
};
