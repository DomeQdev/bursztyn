import { describe, expect, it } from "bun:test";
import { StringInterner, StringReader } from "./index.ts";

const makeStringReader = (interner: StringInterner): StringReader => {
    const { offsets, data } = interner.serialize();
    return new StringReader(offsets, data);
};

describe("StringInterner", () => {
    it("assigns id 0 to the empty string", () => {
        const interner = new StringInterner();
        expect(interner.add("")).toBe(0);
        expect(interner.get(0)).toBe("");
    });

    it("dedupes repeated strings to the same id", () => {
        const interner = new StringInterner();
        const first = interner.add("Rondo ONZ");
        const second = interner.add("Rondo ONZ");
        expect(first).toBe(second);
        expect(interner.add("Dworzec")).not.toBe(first);
    });

    it("roundtrips through serialize + StringReader with UTF-8 multibyte", () => {
        const interner = new StringInterner();
        const kr = interner.add("Kraków");
        const emoji = interner.add("🚋 tram");
        const reader = makeStringReader(interner);

        expect(reader.get(0)).toBe("");
        expect(reader.get(kr)).toBe("Kraków");
        expect(reader.get(emoji)).toBe("🚋 tram");
    });

    it("serializes ASCII and multi-byte strings through the same offsets", () => {
        // ASCII takes the direct path; anything else goes through the encoder,
        // and the buffer is sized for the ASCII floor so the multi-byte ones
        // force it to grow mid-table.
        const interner = new StringInterner();
        const values = [
            "plain",
            "zażółć gęślą jaźń",
            "ascii then ż",
            "🚋🚋🚋",
            "",
            "x".repeat(300),
            "ё".repeat(300),
            "mixed ü ascii end",
        ];
        const ids = values.map((value) => interner.add(value));
        const { offsets, data } = interner.serialize();
        const reader = new StringReader(offsets, data);

        expect(offsets.length).toBe(interner.size + 1);
        expect(offsets[offsets.length - 1]).toBe(data.byteLength);
        for (let i = 0; i < values.length; i++) {
            expect(reader.get(ids[i])).toBe(values[i]);
            expect(reader.equals(ids[i], values[i])).toBe(true);
        }
        expect(data).toEqual(new TextEncoder().encode(values.filter((v) => v !== "").join("")));
    });

    it("returns empty string for out-of-range ids", () => {
        const interner = new StringInterner();
        interner.add("a");
        expect(makeStringReader(interner).get(999)).toBe("");
    });

    it("hydrates from a reader preserving every id", () => {
        const original = new StringInterner();
        const ids = ["Kraków", "Gdańsk", "Łódź"].map((name) => original.add(name));
        const hydrated = StringInterner.hydrate(makeStringReader(original));

        for (let i = 0; i < ids.length; i++) {
            expect(hydrated.get(ids[i])).toBe(original.get(ids[i]));
        }
        expect(hydrated.size).toBe(original.size);
        expect(hydrated.add("Kraków")).toBe(ids[0]);
    });
});

describe("StringReader.equals", () => {
    const interner = new StringInterner();
    const ascii = interner.add("Rondo ONZ");
    const latin = interner.add("Kraków");
    const polish = interner.add("Świętokrzyska");
    const emoji = interner.add("🚋 tram");
    const lone = interner.add("a\uD800b");
    const reader = makeStringReader(interner);

    it("matches ASCII without decoding", () => {
        expect(reader.equals(ascii, "Rondo ONZ")).toBe(true);
        expect(reader.equals(ascii, "Rondo ONy")).toBe(false);
        expect(reader.equals(ascii, "Rondo ON")).toBe(false);
        expect(reader.equals(ascii, "Rondo ONZ ")).toBe(false);
    });

    it("matches multi-byte strings against the key's code units", () => {
        expect(reader.equals(latin, "Kraków")).toBe(true);
        expect(reader.equals(latin, "Krakow")).toBe(false);
        expect(reader.equals(latin, "Krakó")).toBe(false);
        expect(reader.equals(latin, "Kraków ")).toBe(false);
        expect(reader.equals(polish, "Świętokrzyska")).toBe(true);
        expect(reader.equals(polish, "Swiętokrzyska")).toBe(false);
        expect(reader.equals(polish, "Świętokrzysk")).toBe(false);
    });

    it("matches surrogate pairs and never a key that is shorter than the bytes allow", () => {
        expect(reader.equals(emoji, "🚋 tram")).toBe(true);
        expect(reader.equals(emoji, "🚋 trak")).toBe(false);
        expect(reader.equals(emoji, "🚌 tram")).toBe(false);
        expect(reader.equals(emoji, "🚋 tra")).toBe(false);
        expect(reader.equals(emoji, "\uD83D tram")).toBe(false);
    });

    it("agrees with get() on what an unpaired surrogate became", () => {
        expect(reader.get(lone)).toBe("a�b");
        expect(reader.equals(lone, "a�b")).toBe(true);
        expect(reader.equals(lone, "a\uD800b")).toBe(false);
    });

    it("keeps the empty-string and out-of-range rules", () => {
        expect(reader.equals(0, "")).toBe(true);
        expect(reader.equals(0, "x")).toBe(false);
        expect(reader.equals(99, "")).toBe(true);
        expect(reader.equals(99, "x")).toBe(false);
    });

    it("gives the decoder's answer for bytes that are not UTF-8", () => {
        // A lone continuation byte, an encoded surrogate, a truncated sequence
        // and a stray 0xFF — each is what a corrupt section could hold, and
        // each decodes to something `equals` must agree with exactly.
        const chunks = [[0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0x61, 0xff, 0x62], [0xc3, 0x41]];
        const offsets = new Uint32Array(chunks.length + 2);
        const bytes: number[] = [];
        chunks.forEach((chunk, i) => {
            bytes.push(...chunk);
            offsets[i + 2] = bytes.length;
        });
        const corrupt = new StringReader(offsets, new Uint8Array(bytes));

        for (let id = 1; id <= chunks.length; id++) {
            const decoded = corrupt.get(id);
            expect(decoded).toContain("�");
            expect(corrupt.equals(id, decoded)).toBe(true);
            expect(corrupt.equals(id, decoded + " ")).toBe(false);
            expect(corrupt.equals(id, "\uD800")).toBe(false);
            expect(corrupt.equals(id, "a")).toBe(false);
        }
    });
});
