import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    defineSchema,
    migration,
    numArray,
    openSnapshotFile,
    readSnapshotFile,
    singleStringRef,
    stringRefArray,
    stringTable,
    writeSnapshotFile,
} from "./index";

const dir = await mkdtemp(join(tmpdir(), "bursztyn-io-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const v1 = defineSchema({
    version: 1,
    fields: {
        strings: stringTable(),
        city: singleStringRef(),
        stopId: stringRefArray(),
        stopLat: numArray(Int32Array),
    },
});

const write = async (name: string): Promise<string> => {
    const builder = v1.builder();
    builder.builders.city.set("warsaw");
    builder.builders.stopId.pushString("R-ONZ");
    builder.builders.stopLat.pushMany([52_232_600, 52_228_400]);

    const path = join(dir, name);
    await writeSnapshotFile(path, builder.build());
    return path;
};

describe("snapshot files", () => {
    it("round-trips through the filesystem", async () => {
        const readers = v1.read(await readSnapshotFile(await write("plain.brsz")));

        expect(readers.city).toBe("warsaw");
        expect(readers.strings.get(readers.stopId[0])).toBe("R-ONZ");
        expect(Array.from(readers.stopLat)).toEqual([52_232_600, 52_228_400]);
    });

    it("reads straight into a SharedArrayBuffer with views over it", async () => {
        const bytes = await readSnapshotFile(await write("shared.brsz"), { shared: true });
        expect(bytes.buffer).toBeInstanceOf(SharedArrayBuffer);

        const readers = v1.read(bytes);
        expect((readers.stopLat.buffer as ArrayBufferLike) === bytes.buffer).toBe(true);
        expect(readers.city).toBe("warsaw");
        expect(Array.from(readers.stopLat)).toEqual([52_232_600, 52_228_400]);
    });

    it("preserves byte-for-byte content across a write/read cycle", async () => {
        const builder = v1.builder();
        builder.builders.city.set("gdansk");
        const original = builder.build();

        const path = join(dir, "exact.brsz");
        await writeSnapshotFile(path, original);
        const loaded = await readSnapshotFile(path);

        expect(loaded.byteLength).toBe(original.byteLength);
        expect(Array.from(loaded)).toEqual(Array.from(original));
    });
});

describe("openSnapshotFile", () => {
    const v2 = defineSchema({
        version: 2,
        fields: { ...v1.fields, stopBearing: numArray(Uint16Array) },
        migrations: [
            migration({
                from: 1,
                to: 2,
                defines: ["stopBearing"],
                up({ previous, builders }) {
                    const ids = previous.get<Uint32Array>("stopId");
                    for (let i = 0; i < ids.length; i++) {
                        builders.stopBearing.push(90);
                    }
                },
            }),
        ],
    });

    it("migrates on open without touching the file", async () => {
        const path = await write("keep.brsz");
        const { readers, report } = await openSnapshotFile(v2, path, { migrate: true });

        expect(report.migrated).toBe(true);
        expect(Array.from(readers.stopBearing)).toEqual([90]);
        expect(v1.matches(await readSnapshotFile(path))).toBe(true);
    });

    it("persists the upgrade when asked to write back", async () => {
        const path = await write("upgrade.brsz");
        await openSnapshotFile(v2, path, { migrate: true, writeBack: true });

        expect(v2.matches(await readSnapshotFile(path))).toBe(true);

        const second = await openSnapshotFile(v2, path, { migrate: true });
        expect(second.report.migrated).toBe(false);
        expect(Array.from(second.readers.stopBearing)).toEqual([90]);
    });

    it("leaves a current snapshot alone", async () => {
        const path = await write("current.brsz");
        const { report } = await openSnapshotFile(v1, path, { migrate: true });
        expect(report.migrated).toBe(false);
    });
});
