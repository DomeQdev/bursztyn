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
import migrations from "./bursztyn";

export const fields = {
    strings: stringTable(),
    city: singleStringRef(),
    stopLookup: hashLookup({ verifyVia: "stopId" }),
    stopId: stringRefArray(),
    stopLabel: stringRefArray(),
    stopLat: numArray(Int32Array),
    stopRoutes: bucketArray(u32()),
    stopBearing: numArray(Uint16Array),
};

export const schema = defineSchema({ fields, migrations });
