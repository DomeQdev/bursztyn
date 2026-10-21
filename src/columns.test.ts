import { describe, expect, it } from "bun:test";
import { assertNumericRange } from "./index.ts";

describe("assertNumericRange", () => {
    it("throws RangeError when a value overflows the ctor range", () => {
        expect(() => assertNumericRange(Uint8Array, [255, 256], "x")).toThrow(RangeError);
        expect(() => assertNumericRange(Uint8Array, [-1], "x")).toThrow(RangeError);
        expect(() => assertNumericRange(Int8Array, [128], "x")).toThrow(RangeError);
    });

    it("names the offending index and label in the message", () => {
        expect(() => assertNumericRange(Uint16Array, [0, 0, 70000], "myField")).toThrow(
            /myField: value 70000 at index 2/,
        );
    });

    it("passes for in-range values and float ctors", () => {
        expect(() => assertNumericRange(Uint8Array, [0, 128, 255], "x")).not.toThrow();
        expect(() => assertNumericRange(Float64Array, [1e300, -1e300], "x")).not.toThrow();
    });
});
