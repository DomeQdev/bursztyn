#!/usr/bin/env node
import { inspect, isSnapshot } from "./format";
import { readSnapshotFile } from "./io";

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
};

const usage = `bursztyn — inspect .brsz snapshots

  bursztyn inspect <file> [--json] [--sort=bytes|name|order] [--top=N]
`;

const args = process.argv.slice(2);
const command = args[0];
const file = args[1];

if (command !== "inspect" || !file) {
    process.stdout.write(usage);
    process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 1);
}

const flag = (name: string): string | undefined =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];

const bytes = await readSnapshotFile(file);

if (!isSnapshot(bytes)) {
    process.stderr.write(`${file} is not a bursztyn snapshot.\n`);
    process.exit(1);
}

const info = inspect(bytes);
const sort = flag("sort") ?? "bytes";
const fields = [...info.fields];

if (sort === "bytes") fields.sort((a, b) => b.bytes - a.bytes);
if (sort === "name") fields.sort((a, b) => a.name.localeCompare(b.name));

const top = Number(flag("top") ?? fields.length);

if (args.includes("--json")) {
    process.stdout.write(
        `${JSON.stringify({ ...info, schemaHash: info.schemaHash.toString(), fields }, null, 2)}\n`,
    );
    process.exit(0);
}

const rows = fields.slice(0, top);
const nameWidth = Math.max(5, ...rows.map((row) => row.name.length));
const sizeWidth = Math.max(5, ...rows.map((row) => formatBytes(row.bytes).length));

process.stdout.write(`${file}\n`);
process.stdout.write(`  format v${info.formatVersion}  schema v${info.schemaVersion}  hash ${info.schemaHash}\n`);
process.stdout.write(`  ${formatBytes(info.totalBytes)} across ${info.fields.length} fields\n\n`);

for (const row of rows) {
    const share = info.totalBytes > 0 ? (row.bytes / info.totalBytes) * 100 : 0;
    process.stdout.write(
        `  ${row.name.padEnd(nameWidth)}  ${formatBytes(row.bytes).padStart(sizeWidth)}  ` +
            `${share.toFixed(1).padStart(5)}%  ${row.signature}\n`,
    );
}

if (rows.length < fields.length) {
    process.stdout.write(`\n  … ${fields.length - rows.length} more\n`);
}
