import {
    bucketArray,
    defineSchema,
    hashLookup,
    migration,
    numArray,
    openSnapshotFile,
    singleStringRef,
    stringRefArray,
    stringTable,
    trigramIndex,
    u32,
    writeSnapshotFile,
} from "../src/index";

const v1 = defineSchema({
    version: 1,
    fields: {
        strings: stringTable(),
        city: singleStringRef(),
        stopLookup: hashLookup({ verifyVia: "stopId" }),
        stopId: stringRefArray(),
        stopName: stringRefArray(),
        stopLat: numArray(Int32Array),
        stopRoutes: bucketArray(u32()),
    },
});

const schema = defineSchema({
    version: 2,
    fields: {
        ...v1.fields,
        stopSearch: trigramIndex(),
    },
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

const STOPS = [
    { id: "R-ONZ", name: "Rondo ONZ", lat: 52.2326, routes: [10, 17, 33] },
    { id: "DW-C", name: "Dworzec Centralny", lat: 52.2284, routes: [10, 25] },
    { id: "PL-K", name: "Plac Konstytucji", lat: 52.2201, routes: [17] },
];

const path = new URL("./stops.brsz", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const writeLegacySnapshot = async () => {
    const builder = v1.builder();
    builder.builders.city.set("warsaw");

    for (const [index, stop] of STOPS.entries()) {
        builder.builders.stopId.pushString(stop.id);
        builder.builders.stopName.pushString(stop.name);
        builder.builders.stopLookup.add(stop.id, index);
        builder.builders.stopLat.push(Math.round(stop.lat * 1e6));
        builder.builders.stopRoutes.addBucket(stop.routes);
    }

    await writeSnapshotFile(path, builder.build());
};

await writeLegacySnapshot();

const { readers, report } = await openSnapshotFile(schema, path, {
    migrate: true,
    writeBack: true,
    log: console.log,
});

console.log(`\nmigrated: ${report.migrated} (v${report.from} -> v${report.to})`);
for (const step of report.steps) {
    console.log(`  carried ${step.carried.length}, rebuilt ${step.rebuilt.length}, added ${step.added.join(", ") || "-"}`);
}

const index = readers.stopLookup.find("DW-C")!;
console.log(`\n${readers.city}: ${readers.strings.get(readers.stopName[index])}`);
console.log(`  lat ${readers.stopLat[index] / 1e6}`);
console.log(`  routes ${Array.from(readers.stopRoutes.slice(index)).join(", ")}`);
console.log(
    `\nsearch "centraln" -> ${readers.stopSearch
        .search("centraln")
        .map((hit) => readers.strings.get(readers.stopName[hit.idx]))
        .join(", ")}`,
);
