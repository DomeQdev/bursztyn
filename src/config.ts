import { extname, resolve } from "node:path";
import { BursztynError } from "./errors.ts";

/**
 * Deliberately not "./bursztyn": a folder named after the package shadows it
 * for bare specifiers, so the schema's own `from "bursztyn"` can land on the
 * migrations folder.
 */
export const DEFAULT_OUT = "./amber";
export const DEFAULT_IMPORT_FROM = "bursztyn";

export interface TargetInput {
    /** Module that exports the schema. */
    schema: string;
    /** Migrations folder. Defaults to `<out>/<name>`. */
    out?: string;
    /** Identity: picks the folder, matches `--only`, names the schema in errors. */
    name?: string;
    /** Which export to take, when one module holds more than one schema. */
    export?: string;
    /** Specifier the generated files import from. Defaults to `"bursztyn"`. */
    importFrom?: string;
}

export interface ConfigFile {
    /** Single-schema shorthand. Mutually exclusive with `schemas`. */
    schema?: string;
    /** The migrations folder, or the folder every schema gets a subfolder in. */
    out?: string;
    importFrom?: string;
    /** One entry per schema. A bare string is `{ schema: "…" }`. */
    schemas?: (string | TargetInput)[];
}

export interface Overrides {
    schema?: string;
    out?: string;
    export?: string;
    only?: string[];
}

export interface Target {
    name: string;
    schema: string;
    out: string;
    export?: string;
    importFrom: string;
    /**
     * True when the project declares its schemas as a list, so a message can
     * say *which* schema it means. False for the single-schema shorthand,
     * where naming one would be noise.
     */
    multiSchema: boolean;
}

export class ConfigError extends BursztynError {}

export const NO_SCHEMA_CONFIGURED =
    `No schema module configured.\n\n  Create bursztyn.config.json:\n\n` +
    `    { "schema": "./src/schema.ts", "out": "./amber" }\n\n` +
    `  …or, for a project with several schemas:\n\n` +
    `    { "schemas": ["./src/stops.ts", "./src/routes.ts"], "out": "./amber" }\n\n` +
    `  …or pass --schema <path>.`;

/** `schema.ts` says nothing; the folder holding it usually does. */
const GENERIC_STEMS = new Set(["schema", "schemas", "index", "main", "mod"]);

const segments = (path: string): string[] =>
    path.split(/[\\/]/).filter((part) => part.length > 0 && part !== ".");

export const deriveName = (path: string): string => {
    const parts = segments(path);
    const file = parts.at(-1) ?? "schema";
    // "stops.schema.ts" is a schema named stops, not one named stops.schema.
    const stem = file.slice(0, file.length - extname(file).length).replace(/\.schema$/, "");
    if (!GENERIC_STEMS.has(stem)) return stem;

    // src/stops/schema.ts and src/routes/schema.ts would otherwise both be
    // called "schema" and collide on the same folder.
    const parent = parts.at(-2);
    return parent !== undefined && parent !== ".." ? parent : stem;
};

const trimTrailingSlash = (path: string): string => path.replace(/[\\/]+$/, "");

const toTarget = (
    entry: string | TargetInput,
    index: number,
    root: string,
    importFrom: string,
): Target => {
    const input: TargetInput = typeof entry === "string" ? { schema: entry } : entry;

    if (typeof input?.schema !== "string" || input.schema.length === 0) {
        throw new ConfigError(
            `schemas[${index}] has no "schema" path.\n\n` +
                `  Each entry is a module path, or { "schema": "./src/stops.ts", … }.`,
        );
    }

    const name = input.name ?? input.export ?? deriveName(input.schema);

    return {
        name,
        schema: input.schema,
        out: input.out ?? `${trimTrailingSlash(root)}/${name}`,
        export: input.export,
        importFrom: input.importFrom ?? importFrom,
        multiSchema: true,
    };
};

/**
 * Every schema owns its folder outright — the journal in it *is* the version
 * numbering, so two schemas sharing one would renumber each other's history.
 * Caught here rather than after the first file is written.
 */
const assertDistinct = (targets: Target[]) => {
    const byName = new Map<string, Target>();
    const byOut = new Map<string, Target>();
    const bySource = new Map<string, Target>();

    for (const target of targets) {
        const sameName = byName.get(target.name);
        if (sameName) {
            throw new ConfigError(
                `Two schemas are both called "${target.name}" ` +
                    `(${sameName.schema} and ${target.schema}).\n\n` +
                    `  Give one of them a "name" in bursztyn.config.json.`,
            );
        }
        byName.set(target.name, target);

        const sameOut = byOut.get(resolve(target.out));
        if (sameOut) {
            throw new ConfigError(
                `"${sameOut.name}" and "${target.name}" both write migrations to ${target.out}.\n\n` +
                    `  A folder holds one schema's journal, so its version numbers are that\n` +
                    `  schema's alone. Give each an "out", or drop the shared one and let the\n` +
                    `  default per-name folder apply.`,
            );
        }
        byOut.set(resolve(target.out), target);

        const source = `${resolve(target.schema)}#${target.export ?? ""}`;
        const sameSource = bySource.get(source);
        if (sameSource) {
            throw new ConfigError(
                `"${sameSource.name}" and "${target.name}" are the same schema ` +
                    `(${target.schema}${target.export ? ` → ${target.export}` : ""}).\n\n` +
                    `  Two folders migrating one schema drift apart. Keep one, or point the\n` +
                    `  second at a different "export".`,
            );
        }
        bySource.set(source, target);
    }
};

/**
 * Turns a config file plus CLI flags into the list of schemas to work on.
 * Pure: every path stays as written, so the caller decides what to resolve.
 */
export const resolveTargets = (file: ConfigFile, overrides: Overrides = {}): Target[] => {
    if (file.schema !== undefined && file.schemas !== undefined) {
        throw new ConfigError(
            `bursztyn.config.json has both "schema" and "schemas" — keep one.\n\n` +
                `  "schemas" is the list; "schema" is the shorthand for a project with one.`,
        );
    }

    const importFrom = file.importFrom ?? DEFAULT_IMPORT_FROM;
    const root = overrides.out ?? file.out ?? DEFAULT_OUT;
    let targets: Target[];

    if (overrides.schema !== undefined) {
        // An explicit --schema is a one-off: it replaces the configured list
        // rather than joining it, and writes straight into --out.
        targets = [
            {
                name: overrides.export ?? deriveName(overrides.schema),
                schema: overrides.schema,
                out: root,
                export: overrides.export,
                importFrom,
                multiSchema: false,
            },
        ];
    } else if (file.schemas !== undefined) {
        if (!Array.isArray(file.schemas)) {
            throw new ConfigError(
                `"schemas" must be an array of module paths.\n\n` +
                    `    { "schemas": ["./src/stops.ts", "./src/routes.ts"] }`,
            );
        }
        if (file.schemas.length === 0) {
            throw new ConfigError(`"schemas" is empty — add at least one schema module.`);
        }

        targets = file.schemas.map((entry, index) => toTarget(entry, index, root, importFrom));
    } else if (file.schema !== undefined) {
        targets = [
            {
                name: deriveName(file.schema),
                schema: file.schema,
                out: root,
                export: overrides.export,
                importFrom,
                multiSchema: false,
            },
        ];
    } else {
        throw new ConfigError(NO_SCHEMA_CONFIGURED);
    }

    assertDistinct(targets);

    const only = overrides.only ?? [];
    if (only.length === 0) return targets;

    const unknown = only.filter((name) => !targets.some((target) => target.name === name));
    if (unknown.length > 0) {
        throw new ConfigError(
            `No schema called "${unknown[0]}".\n\n` +
                `  This project has: ${targets.map((target) => target.name).join(", ")}`,
        );
    }

    return targets.filter((target) => only.includes(target.name));
};
