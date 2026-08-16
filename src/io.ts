import type { OpenOptions, OpenResult, Schema } from "./schema";
import type { SchemaShape } from "./types";

export interface ReadFileOptions {
    shared?: boolean;
}

export const readSnapshotFile = async (
    path: string,
    options: ReadFileOptions = {},
): Promise<Uint8Array> => {
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");

    try {
        const { size } = await handle.stat();
        const bytes = new Uint8Array(
            options.shared ? new SharedArrayBuffer(size) : new ArrayBuffer(size),
        );

        let offset = 0;
        while (offset < size) {
            const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }

        return bytes;
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
