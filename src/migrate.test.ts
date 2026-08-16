import { describe, expect, it } from "bun:test";
import {
    bucketArray,
    CarryConflictError,
    defineSchema,
    hashLookup,
    migration,
    MigrationDataLossError,
    MigrationPathError,
    numArray,
    singleStringRef,
    stringRefArray,
    stringTable,
    u32,
    type BucketArrayReader,
} from "./index";

const v1 = defineSchema({
    version: 1,
    fields: {
        strings: stringTable(),
        cityName: singleStringRef(),
        stopLookup: hashLookup({ verifyVia: "stopId" }),
        stopId: stringRefArray(),
        stopName: stringRefArray(),
        stopLat: numArray(Int32Array),
        stopRoutes: bucketArray(u32()),
    },
});

const STOPS = [
    { id: "stop-a", name: "Rondo ONZ", lat: 52_231_000, routes: [1, 2] },
    { id: "stop-b", name: "Dworzec Centralny", lat: 52_228_000, routes: [] },
    { id: "stop-c", name: "Kraków Główny", lat: 50_067_000, routes: [7] },
];

const buildV1 = () => {
    const builder = v1.builder();
    builder.builders.cityName.set("warsaw");

    for (const [index, stop] of STOPS.entries()) {
        builder.builders.stopId.pushString(stop.id);
        builder.builders.stopName.pushString(stop.name);
        builder.builders.stopLookup.add(stop.id, index);
        builder.builders.stopLat.push(stop.lat);
        builder.builders.stopRoutes.addBucket(stop.routes);
    }

    return builder.build();
};

const v3 = defineSchema({
    version: 3,
    fields: {
        strings: stringTable(),
        city: singleStringRef(),
        stopLookup: hashLookup({ verifyVia: "stopId" }),
        stopId: stringRefArray(),
        stopName: stringRefArray(),
        stopLat: numArray(Float64Array),
        stopRoutes: bucketArray(u32()),
        stopBearing: numArray(Uint16Array),
    },
    migrations: [
        migration({
            from: 1,
            to: 2,
            description: "rename cityName -> city, add stopBearing",
            renames: { cityName: "city" },
            defines: ["stopBearing"],
            up({ previous, builders }) {
                const count = previous.get<Uint32Array>("stopId").length;
                for (let i = 0; i < count; i++) {
                    builders.stopBearing.push(90);
                }
            },
        }),
        migration({
            from: 2,
            to: 3,
            description: "store latitude as degrees",
            defines: ["stopLat"],
            up({ previous, builders }) {
                const lat = previous.get<Int32Array>("stopLat");
                for (let i = 0; i < lat.length; i++) {
                    builders.stopLat.push(lat[i] / 1e6);
                }
            },
        }),
    ],
});

describe("migration chain", () => {
    it("carries untouched fields and rebuilds the rest", async () => {
        const { bytes, report } = await v3.migrate(buildV1());

        expect(report.migrated).toBe(true);
        expect(report.from).toBe(1);
        expect(report.to).toBe(3);
        expect(report.steps).toHaveLength(2);

        expect(report.steps[0].carried).toContain("stopName");
        expect(report.steps[0].carried).toContain("stopRoutes");
        expect(report.steps[0].carried).toContain("city");
        expect(report.steps[0].added).toEqual(["stopBearing"]);
        expect(report.steps[0].renamed).toEqual([{ from: "cityName", to: "city" }]);

        expect(report.steps[1].rebuilt).toEqual(["stopLat"]);
        expect(report.steps[1].carried).toContain("stopBearing");

        expect(v3.matches(bytes)).toBe(true);
    });

    it("keeps carried string references resolvable through the hydrated table", async () => {
        const { bytes } = await v3.migrate(buildV1());
        const readers = v3.read(bytes);

        expect(readers.city).toBe("warsaw");
        for (const [index, stop] of STOPS.entries()) {
            expect(readers.strings.get(readers.stopName[index])).toBe(stop.name);
            expect(readers.strings.get(readers.stopId[index])).toBe(stop.id);
        }
    });

    it("keeps carried hash lookups working after the verifier field survives", async () => {
        const { bytes } = await v3.migrate(buildV1());
        const readers = v3.read(bytes);

        expect(readers.stopLookup.find("stop-c")).toBe(2);
        expect(readers.stopLookup.find("stop-a")).toBe(0);
        expect(readers.stopLookup.find("nope")).toBeUndefined();
    });

    it("applies both transformations", async () => {
        const { bytes } = await v3.migrate(buildV1());
        const readers = v3.read(bytes);

        expect(Array.from(readers.stopLat)).toEqual([52.231, 52.228, 50.067]);
        expect(Array.from(readers.stopBearing)).toEqual([90, 90, 90]);
        expect(Array.from((readers.stopRoutes as BucketArrayReader<any>).slice(0))).toEqual([1, 2]);
    });

    it("is a no-op when the snapshot already matches", async () => {
        const current = v3.builder();
        current.builders.city.set("warsaw");
        const { report } = await v3.migrate(current.build());

        expect(report.migrated).toBe(false);
        expect(report.steps).toHaveLength(0);
    });

    it("open() migrates transparently and returns typed readers", async () => {
        const { readers, report } = await v3.open(buildV1());

        expect(report.migrated).toBe(true);
        expect(readers.city).toBe("warsaw");
        expect(readers.stopBearing.length).toBe(3);
    });

    it("refuses to migrate when asked not to", async () => {
        await expect(v3.open(buildV1(), { migrate: false })).rejects.toThrow(/does not match/);
    });
});

describe("migration guard rails", () => {
    it("rejects a schema whose migrations do not reach its version", () => {
        expect(() =>
            defineSchema({
                version: 3,
                fields: { strings: stringTable() },
                migrations: [migration({ from: 1, to: 2 })],
            }),
        ).toThrow(/lands on version 2 but the schema declares version 3/);
    });

    it("rejects a chain with a gap", () => {
        expect(() =>
            defineSchema({
                version: 4,
                fields: { strings: stringTable() },
                migrations: [migration({ from: 1, to: 2 }), migration({ from: 3, to: 4 })],
            }),
        ).toThrow(MigrationPathError);
    });

    it("refuses a snapshot from an unknown older version", async () => {
        const orphan = defineSchema({
            version: 9,
            fields: { strings: stringTable(), city: singleStringRef() },
            migrations: [migration({ from: 8, to: 9, defines: ["city"] })],
        });

        await expect(orphan.migrate(buildV1())).rejects.toThrow(MigrationPathError);
    });

    it("refuses a snapshot newer than the current schema", async () => {
        const future = defineSchema({ version: 99, fields: v1.fields }).builder().build();
        await expect(v3.migrate(future)).rejects.toThrow(/only run forward/);
    });

    it("names the field when a migration leaves the schema unreachable", async () => {
        const forgetful = defineSchema({
            version: 2,
            fields: { ...v1.fields, stopBearing: numArray(Uint16Array) },
            migrations: [migration({ from: 1, to: 2 })],
        });

        await expect(forgetful.migrate(buildV1())).rejects.toThrow(
            /"stopBearing" is in the schema but no migration creates it/,
        );
    });

    it("names the field when a migration leaves a stale field behind", async () => {
        const { stopRoutes, ...withoutRoutes } = v1.fields;
        const forgetful = defineSchema({
            version: 2,
            fields: withoutRoutes,
            migrations: [migration({ from: 1, to: 2 })],
        });

        await expect(forgetful.migrate(buildV1())).rejects.toThrow(
            /"stopRoutes" survives the migration but is not in the schema/,
        );
    });

    it("blocks a rebuild that silently drops data", async () => {
        const lossy = defineSchema({
            version: 2,
            fields: { ...v1.fields, stopLat: numArray(Float64Array) },
            migrations: [migration({ from: 1, to: 2, defines: ["stopLat"] })],
        });

        await expect(lossy.migrate(buildV1())).rejects.toThrow(MigrationDataLossError);
    });

    it("allows the loss once it is declared", async () => {
        const deliberate = defineSchema({
            version: 2,
            fields: { ...v1.fields, stopLat: numArray(Float64Array) },
            migrations: [migration({ from: 1, to: 2, defines: ["stopLat"], drops: ["stopLat"] })],
        });

        const { bytes } = await deliberate.migrate(buildV1());
        expect(deliberate.read(bytes).stopLat.length).toBe(0);
    });

    it("catches writes to an auto-carried field", async () => {
        const clashing = defineSchema({
            version: 2,
            fields: v1.fields,
            migrations: [
                migration({
                    from: 1,
                    to: 2,
                    up({ builders }) {
                        builders.stopLat.push(1);
                    },
                }),
            ],
        });

        await expect(clashing.migrate(buildV1())).rejects.toThrow(CarryConflictError);
    });

    it("lets a rebuild opt out of carrying", async () => {
        const recomputed = defineSchema({
            version: 2,
            fields: v1.fields,
            migrations: [
                migration({
                    from: 1,
                    to: 2,
                    rebuilds: ["stopLat"],
                    up({ previous, builders }) {
                        const lat = previous.get<Int32Array>("stopLat");
                        for (let i = 0; i < lat.length; i++) {
                            builders.stopLat.push(lat[i] + 1);
                        }
                    },
                }),
            ],
        });

        const { bytes, report } = await recomputed.migrate(buildV1());
        expect(report.steps[0].rebuilt).toEqual(["stopLat"]);
        expect(Array.from(recomputed.read(bytes).stopLat)).toEqual(STOPS.map((stop) => stop.lat + 1));
    });

    it("drops a field the schema no longer declares", async () => {
        const { stopRoutes, ...withoutRoutes } = v1.fields;
        const slimmed = defineSchema({
            version: 2,
            fields: withoutRoutes,
            migrations: [migration({ from: 1, to: 2, drops: ["stopRoutes"] })],
        });

        const { bytes, report } = await slimmed.migrate(buildV1());
        expect(report.steps[0].dropped).toEqual(["stopRoutes"]);
        expect(slimmed.read(bytes).stopName.length).toBe(3);
        expect(Object.keys(slimmed.inspect(bytes).fields)).not.toContain("stopRoutes");
    });

    it("reports what a migration cannot resolve on its own", async () => {
        const unknown = defineSchema({
            version: 2,
            fields: v1.fields,
            migrations: [migration({ from: 1, to: 2, defines: ["ghost"] })],
        });

        await expect(unknown.migrate(buildV1())).rejects.toThrow(
            /defines "ghost", but the current schema has no such field/,
        );
    });
});
