import { describe, expect, it } from "bun:test";
import { hashStringToBigint, TrigramIndexBuilder, TrigramIndexReader } from "../index.ts";

describe("TrigramIndexReader", () => {
    const build = (names: [number, string][]): TrigramIndexReader => {
        const builder = new TrigramIndexBuilder();
        for (const [idx, name] of names) {
            builder.addEntry(idx, name);
        }
        const { keysLow, keysHigh, values, ptr, data } = builder.finalize();
        return new TrigramIndexReader(keysLow, keysHigh, values, ptr, data);
    };

    it("returns an empty array for an empty query", () => {
        expect(build([[0, "Rondo"]]).search("")).toEqual([]);
    });

    it("finds the matching entity and excludes unrelated ones", () => {
        const results = build([
            [0, "Rondo ONZ"],
            [1, "Dworzec Centralny"],
        ]).search("Dworzec");

        expect(results.map((r) => r.idx)).toContain(1);
        expect(results.map((r) => r.idx)).not.toContain(0);
    });

    it("ranks the best match first by trigram overlap", () => {
        const results = build([
            [0, "Centrum"],
            [1, "Centralna"],
            [2, "Ogród"],
        ]).search("Centralna");

        expect(results[0].idx).toBe(1);
        for (let i = 1; i < results.length; i++) {
            expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
        }
    });

    it("truncates to the requested limit", () => {
        const reader = build([
            [0, "Aleja Jana"],
            [1, "Aleja Jana Pawla"],
            [2, "Aleja Jana Kazimierza"],
        ]);
        expect(reader.search("Aleja Jana", { limit: 1 }).length).toBe(1);
    });

    // The reference: score every name by how many of the query's trigram
    // positions it contains, apply the same cutoff, sort by score. The reader
    // must agree on membership and scores, rank monotonically, and hand out a
    // limited result that is a prefix of the unlimited one.
    const trigramsOf = (s: string): string[] => {
        const lower = s.toLowerCase();
        if (lower.length === 0) return [];
        if (lower.length < 3) return [lower];
        const out: string[] = [];
        for (let i = 0; i + 3 <= lower.length; i++) out.push(lower.slice(i, i + 3));
        return out;
    };
    const reference = (names: string[], query: string, ratio = 0.7) => {
        const qt = trigramsOf(query);
        const scored = names.map((name, idx) => {
            const own = new Set(trigramsOf(name));
            let score = 0;
            for (const t of qt) if (own.has(t)) score++;
            return { idx, score };
        });
        const max = Math.max(0, ...scored.map((s) => s.score));
        const cutoff = Math.max(Math.max(1, qt.length - 1), max * ratio);
        return scored.filter((s) => s.score >= cutoff).sort((a, b) => b.score - a.score);
    };

    it("agrees with a naive scorer on membership, scores and ranking", () => {
        const syllables = ["war", "sza", "wa", "kra", "kow", "ron", "do", "onz", "plac", "ul", "ana", "ban"];
        const names: string[] = [];
        let seed = 7;
        for (let i = 0; i < 400; i++) {
            let name = "";
            const parts = 1 + (i % 4);
            for (let k = 0; k < parts; k++) {
                seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
                name += syllables[seed % syllables.length] + (k % 2 === 0 ? "" : " ");
            }
            names.push(name.trim() + (i % 3 === 0 ? ` ${i}` : ""));
        }
        const reader = build(names.map((name, idx) => [idx, name]));

        for (const query of ["war", "banana", "kra ków", "plac onz", "wa", "ul ana", "aaaa", "ronda"]) {
            const expected = reference(names, query);
            const actual = reader.search(query);

            expect(actual.length).toBe(expected.length);
            const expectedScores = new Map(expected.map((e) => [e.idx, e.score]));
            for (const { idx, score } of actual) expect(score).toBe(expectedScores.get(idx)!);
            for (let i = 1; i < actual.length; i++) {
                expect(actual[i].score).toBeLessThanOrEqual(actual[i - 1].score);
            }

            for (const limit of [0, 1, 5, 17, 1000]) {
                expect(reader.search(query, { limit })).toEqual(actual.slice(0, limit));
            }
            expect(reader.search(query, { limit: 3, dynamicCutoffRatio: 0.2 })).toEqual(
                reader.search(query, { dynamicCutoffRatio: 0.2 }).slice(0, 3),
            );
        }
    });

    it("builds the same index from text as from precomputed trigram hashes", () => {
        // addEntry lowercases ASCII per code unit and hashes code units
        // directly; addHash is the reference path through hashString. Both
        // must land every trigram in the same bucket, byte for byte.
        const names = ["Dworzec GŁÓWNY", "ŻABKA", "Rondo ONZ", "ab", "a", "banana", "İstanbul", "Plac Zamkowy"];
        const viaText = new TrigramIndexBuilder();
        const viaHash = new TrigramIndexBuilder();

        names.forEach((name, idx) => {
            viaText.addEntry(idx, name);
            for (const trigram of trigramsOf(name)) viaHash.addHash(hashStringToBigint(trigram), idx);
        });

        const a = viaText.finalize();
        const b = viaHash.finalize();
        expect(a.keysLow).toEqual(b.keysLow);
        expect(a.keysHigh).toEqual(b.keysHigh);
        expect(a.values).toEqual(b.values);
        expect(a.ptr).toEqual(b.ptr);
        expect(a.data).toEqual(b.data);
    });

    it("matches regardless of case, in ASCII and beyond", () => {
        const reader = build([
            [0, "BANANA"],
            [1, "banana"],
            [2, "ŻÓŁW"],
            [3, "żółw"],
        ]);
        expect(reader.search("Banana").map((r) => r.idx)).toEqual([0, 1]);
        expect(reader.search("żółw").map((r) => r.idx)).toEqual([2, 3]);
        expect(reader.search("ŻÓŁW").map((r) => r.score)).toEqual([2, 2]);
    });

    it("returns nothing when two of the query's trigrams are unknown", () => {
        const reader = build([[0, "Rondo ONZ"]]);
        expect(reader.search("Ronxxo")).toEqual([]);
        expect(reader.search("Rondq").map((r) => r.idx)).toEqual([0]);
    });

    it("scores sparse entity ids the same way as dense ones", () => {
        // Ids far apart push the reader onto its Map scratch instead of the
        // typed-array one; the candidate rule has to hold on both.
        const sparse = build([
            [0, "Rondo ONZ"],
            [5_000_000, "Rondo ONZ"],
            [50_000_000, "Rondo Daszyńskiego"],
            [900_000_000, "Ogród Saski"],
        ]);
        const dense = build([
            [0, "Rondo ONZ"],
            [1, "Rondo ONZ"],
            [2, "Rondo Daszyńskiego"],
            [3, "Ogród Saski"],
        ]);
        for (const query of ["rondo onz", "rondo", "rondo da", "saski", "zzz"]) {
            expect(sparse.search(query).map((r) => r.score)).toEqual(dense.search(query).map((r) => r.score));
        }
        expect(sparse.search("rondo onz").map((r) => r.idx)).toEqual([0, 5_000_000]);
        expect(sparse.search("rondo").map((r) => r.idx)).toEqual([0, 5_000_000, 50_000_000]);
    });

    it("keeps ties in first-seen order across repeated searches", () => {
        const reader = build([
            [3, "Aleja"],
            [1, "Aleja"],
            [2, "Aleja"],
        ]);
        const first = reader.search("aleja").map((r) => r.idx);
        expect(first).toEqual([3, 1, 2]);
        expect(reader.search("aleja").map((r) => r.idx)).toEqual(first);
        expect(reader.search("aleja", { limit: 2 }).map((r) => r.idx)).toEqual([3, 1]);
    });
});
