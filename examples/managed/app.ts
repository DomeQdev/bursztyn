import {
    bucketArray,
    defineSchema,
    hashLookup,
    numArray,
    singleStringRef,
    stringRefArray,
    stringTable,
    u32,
} from "../../src/index";
import { schema } from "./schema";

const legacy = defineSchema({
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

const old = legacy.builder();
old.builders.city.set("warsaw");
for (const [index, stop] of [
    ["R-ONZ", "Rondo ONZ"],
    ["DW-C", "Dworzec Centralny"],
].entries()) {
    old.builders.stopId.pushString(stop[0]);
    old.builders.stopName.pushString(stop[1]);
    old.builders.stopLookup.add(stop[0], index);
    old.builders.stopLat.push(52_230_000 + index);
    old.builders.stopRoutes.addBucket([10 + index]);
}

console.log(`schema in code: v${schema.version}, ${Object.keys(schema.fields).length} fields`);

const { readers, report } = await schema.open(old.build(), { migrate: true, log: console.log });

console.log(`migrated: ${report.migrated} (v${report.from} -> v${report.to})`);
for (const step of report.steps) {
    console.log(`  ${step.carried.length} carried, ${step.added.join(", ") || "none"} added`);
}

const index = readers.stopLookup.find("DW-C")!;
console.log(`${readers.city}: ${readers.strings.get(readers.stopLabel[index])}`);
console.log(`  bearing ${readers.stopBearing[index]}, routes ${Array.from(readers.stopRoutes.slice(index))}`);
