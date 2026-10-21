import { describe, expect, it } from "bun:test";
import { HashLookupBuilder, HashLookupReader } from "../index.ts";

const buildHashLookup = (entries: [key: string, value: number][]): HashLookupReader => {
    const builder = new HashLookupBuilder();
    for (const [key, value] of entries) {
        builder.add(key, value);
    }
    const { keysLow, keysHigh, values } = builder.finalize();
    return new HashLookupReader(keysLow, keysHigh, values);
};

describe("HashLookupReader", () => {
    it("finds every inserted key", () => {
        const entries: [string, number][] = [];
        for (let i = 0; i < 500; i++) {
            entries.push([`stop-${i}`, i * 7]);
        }
        const reader = buildHashLookup(entries);
        for (const [key, value] of entries) {
            expect(reader.find(key)).toBe(value);
        }
    });

    it("returns undefined for a missing key and for an empty table", () => {
        expect(buildHashLookup([["a", 1]]).find("nope")).toBeUndefined();
        expect(buildHashLookup([]).find("anything")).toBeUndefined();
    });

    it("stores a value of 0 without treating the slot as empty", () => {
        const reader = buildHashLookup([
            ["zero", 0],
            ["one", 1],
        ]);
        expect(reader.find("zero")).toBe(0);
        expect(reader.find("one")).toBe(1);
    });

    it("handles the all-zero hash sentinel via addRaw", () => {
        const builder = new HashLookupBuilder();
        builder.addRaw(0n, 42);
        builder.addRaw(123n, 7);
        const { keysLow, keysHigh, values } = builder.finalize();
        const reader = new HashLookupReader(keysLow, keysHigh, values);
        expect(reader.findRaw(0n)).toBe(42);
        expect(reader.findRaw(123n)).toBe(7);
    });

    it("respects the verifier", () => {
        const reject = buildHashLookup([["alpha", 10]]);
        reject.setVerifier(() => "WRONG");
        expect(reject.find("alpha")).toBeUndefined();

        const accept = buildHashLookup([["alpha", 10]]);
        accept.setVerifier(() => "alpha");
        expect(accept.find("alpha")).toBe(10);
    });
});
