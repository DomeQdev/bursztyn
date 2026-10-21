import type { Target } from "../config.ts";

// What the CLI takes from the terminal and what it writes back: the parsed
// argv, the colour helpers, and the one piece of shared output state (the
// indent a target's block sits under when a run covers several schemas).

export const tty = process.stdout.isTTY === true;
const paint = (code: string, text: string) => (tty ? `[${code}m${text}[0m` : text);
export const bold = (text: string) => paint("1", text);
export const dim = (text: string) => paint("2", text);
export const red = (text: string) => paint("31", text);
export const green = (text: string) => paint("32", text);
export const yellow = (text: string) => paint("33", text);

/**
 * Indented while a run is working through one schema of several, so a target's
 * whole block sits under its heading without every call knowing about it.
 */
let indent = "";

export const write = (text: string) => process.stdout.write(text.length === 0 ? "\n" : `${indent}${text}\n`);
export const warn = (text: string) => process.stderr.write(`${yellow("!")} ${text}\n`);
export const fail = (text: string): never => {
    process.stderr.write(`${red("✗")} ${text}\n`);
    process.exit(1);
};

export const setIndent = (value: string) => {
    indent = value;
};

/** `text` under the current indent, for output that bypasses `write`. */
export const indented = (text: string) => `${indent}${text}`;

export const args = process.argv.slice(2);
export const command = args[0];

export const flag = (name: string): string | undefined => {
    const inline = args.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);

    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
};

export const flags = (name: string): string[] =>
    args
        .map((arg, index) =>
            arg === `--${name}` ? args[index + 1] : arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined,
        )
        .filter((value): value is string => value !== undefined);

/** Printed above a target's block, but only when the run covers several. */
export const heading = (target: Target, first: boolean) => {
    if (!first) process.stdout.write("\n");
    process.stdout.write(`${bold(target.name)}  ${dim(target.schema)}\n`);
};
