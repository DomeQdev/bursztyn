import { inspect, isSnapshot } from "../format.ts";
import { readSnapshotHeaderFile } from "../io.ts";
import { args, bold, dim, fail, flag, write } from "./terminal.ts";

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

export const runInspect = async () => {
    const file = args[1];
    if (!file) fail("bursztyn inspect <file.brsz>");

    // Sizes all come out of the manifest and the section table, so inspecting a
    // 4 GiB snapshot reads a few kilobytes of it.
    const { bytes, size } = await readSnapshotHeaderFile(file);
    if (!isSnapshot(bytes)) fail(`${file} is not a bursztyn snapshot.`);

    const info = inspect(bytes, size);
    const sort = flag("sort") ?? "bytes";
    const fields = [...info.fields];

    if (sort === "bytes") fields.sort((a, b) => b.bytes - a.bytes);
    if (sort === "name") fields.sort((a, b) => a.name.localeCompare(b.name));

    if (args.includes("--json")) {
        write(JSON.stringify({ ...info, schemaHash: info.schemaHash.toString(), fields }, null, 2));
        return;
    }

    const rows = fields.slice(0, Number(flag("top") ?? fields.length));
    const nameWidth = Math.max(5, ...rows.map((row) => row.name.length));
    const sizeWidth = Math.max(5, ...rows.map((row) => formatBytes(row.bytes).length));

    write(bold(file));
    write(dim(`  format v${info.formatVersion}  schema v${info.schemaVersion}  hash ${info.schemaHash}`));
    write(`  ${formatBytes(info.totalBytes)} across ${info.fields.length} fields\n`);

    for (const row of rows) {
        const share = info.totalBytes > 0 ? (row.bytes / info.totalBytes) * 100 : 0;
        write(
            `  ${row.name.padEnd(nameWidth)}  ${formatBytes(row.bytes).padStart(sizeWidth)}  ` +
                `${share.toFixed(1).padStart(5)}%  ${dim(row.signature)}`,
        );
    }

    if (rows.length < fields.length) write(dim(`\n  … ${fields.length - rows.length} more`));
};
