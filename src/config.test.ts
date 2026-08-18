import { describe, expect, it } from "bun:test";
import { ConfigError, deriveName, resolveTargets, type ConfigFile } from "./index.ts";

const names = (file: ConfigFile, overrides = {}) =>
    resolveTargets(file, overrides).map((target) => `${target.name} → ${target.out}`);

describe("deriveName", () => {
    it("uses the file stem", () => {
        expect(deriveName("./src/stops.ts")).toBe("stops");
    });

    it("drops a .schema suffix", () => {
        expect(deriveName("./src/stops.schema.ts")).toBe("stops");
    });

    it("falls back to the folder when the file is called schema.ts", () => {
        expect(deriveName("./src/stops/schema.ts")).toBe("stops");
        expect(deriveName("./src/routes/index.ts")).toBe("routes");
    });

    it("keeps the stem when there is no folder to fall back to", () => {
        expect(deriveName("schema.ts")).toBe("schema");
    });
});

describe("resolveTargets", () => {
    it("reads the single-schema shorthand as one flat target", () => {
        const targets = resolveTargets({ schema: "./src/schema.ts", out: "./amber" });

        expect(targets).toHaveLength(1);
        expect(targets[0].out).toBe("./amber");
        expect(targets[0].multiSchema).toBe(false);
    });

    it("defaults the single-schema folder to ./amber", () => {
        expect(resolveTargets({ schema: "./src/schema.ts" })[0].out).toBe("./amber");
    });

    it("gives every listed schema its own folder", () => {
        expect(names({ schemas: ["./src/stops.ts", "./src/routes.ts"] })).toEqual([
            "stops → ./amber/stops",
            "routes → ./amber/routes",
        ]);
    });

    it("puts those folders under a configured out", () => {
        expect(names({ schemas: ["./src/stops.ts"], out: "./migrations/" })).toEqual([
            "stops → ./migrations/stops",
        ]);
    });

    it("marks listed schemas so messages can name them", () => {
        expect(resolveTargets({ schemas: ["./src/stops.ts"] })[0].multiSchema).toBe(true);
    });

    it("takes name, out, export and importFrom from an entry", () => {
        const [target] = resolveTargets({
            schemas: [
                {
                    schema: "./src/all.ts",
                    name: "transit",
                    out: "./amber/transit",
                    export: "stopSchema",
                    importFrom: "../../src/index.ts",
                },
            ],
        });

        expect(target).toEqual({
            name: "transit",
            schema: "./src/all.ts",
            out: "./amber/transit",
            export: "stopSchema",
            importFrom: "../../src/index.ts",
            multiSchema: true,
        });
    });

    it("names a target after its export when the module holds several", () => {
        expect(
            names({
                schemas: [
                    { schema: "./src/all.ts", export: "stops" },
                    { schema: "./src/all.ts", export: "routes" },
                ],
            }),
        ).toEqual(["stops → ./amber/stops", "routes → ./amber/routes"]);
    });

    it("inherits a config-level importFrom", () => {
        const [target] = resolveTargets({ schemas: ["./src/stops.ts"], importFrom: "@acme/amber" });
        expect(target.importFrom).toBe("@acme/amber");
    });

    it("refuses both schema and schemas", () => {
        expect(() => resolveTargets({ schema: "./a.ts", schemas: ["./b.ts"] })).toThrow(ConfigError);
    });

    it("refuses two schemas with the same name", () => {
        expect(() => resolveTargets({ schemas: ["./src/a/stops.ts", "./src/b/stops.ts"] })).toThrow(
            /both called "stops"/,
        );
    });

    it("refuses two schemas sharing a folder, because the journal is per folder", () => {
        expect(() =>
            resolveTargets({
                schemas: [
                    { schema: "./src/stops.ts", out: "./amber" },
                    { schema: "./src/routes.ts", out: "./amber" },
                ],
            }),
        ).toThrow(/both write migrations to/);
    });

    it("refuses two targets pointing at one schema", () => {
        expect(() =>
            resolveTargets({
                schemas: [
                    { schema: "./src/stops.ts", name: "one" },
                    { schema: "./src/stops.ts", name: "two" },
                ],
            }),
        ).toThrow(/are the same schema/);
    });

    it("refuses an entry without a path", () => {
        expect(() => resolveTargets({ schemas: [{} as any] })).toThrow(/schemas\[0\]/);
    });

    it("refuses an empty or malformed list", () => {
        expect(() => resolveTargets({ schemas: [] })).toThrow(/empty/);
        expect(() => resolveTargets({ schemas: "./src/stops.ts" as any })).toThrow(/must be an array/);
    });

    it("explains itself when nothing is configured", () => {
        expect(() => resolveTargets({})).toThrow(/No schema module configured/);
    });

    it("selects by name with --only", () => {
        const file: ConfigFile = { schemas: ["./src/stops.ts", "./src/routes.ts", "./src/fares.ts"] };

        expect(names(file, { only: ["routes"] })).toEqual(["routes → ./amber/routes"]);
        expect(names(file, { only: ["fares", "stops"] })).toEqual([
            "stops → ./amber/stops",
            "fares → ./amber/fares",
        ]);
    });

    it("lists the known names when --only misses", () => {
        expect(() =>
            resolveTargets({ schemas: ["./src/stops.ts"] }, { only: ["stpos"] }),
        ).toThrow(/This project has: stops/);
    });

    it("lets --schema replace the configured list", () => {
        const targets = resolveTargets(
            { schemas: ["./src/stops.ts", "./src/routes.ts"] },
            { schema: "./tmp/scratch.ts", out: "./tmp/amber" },
        );

        expect(targets).toHaveLength(1);
        expect(targets[0].out).toBe("./tmp/amber");
        expect(targets[0].multiSchema).toBe(false);
    });

    it("lets --out move the whole list", () => {
        expect(names({ schemas: ["./src/stops.ts"] }, { out: "./generated" })).toEqual([
            "stops → ./generated/stops",
        ]);
    });
});
