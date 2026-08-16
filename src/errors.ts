export class BursztynError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

export class FormatError extends BursztynError {}

export class UnknownSignatureError extends BursztynError {
    constructor(public readonly signature: string) {
        super(
            `Unknown field signature "${signature}". It was written by a newer bursztyn, ` +
                `or by a custom field type that this build does not register.`,
        );
    }
}

export type FieldDiff =
    | { kind: "added"; name: string; signature: string }
    | { kind: "removed"; name: string; signature: string }
    | { kind: "changed"; name: string; before: string; after: string }
    | { kind: "moved"; name: string; before: number; after: number };

export const formatDiff = (diff: FieldDiff[]): string => {
    return diff
        .map((entry) => {
            switch (entry.kind) {
                case "added":
                    return `  + ${entry.name} (${entry.signature})`;
                case "removed":
                    return `  - ${entry.name} (${entry.signature})`;
                case "changed":
                    return `  ~ ${entry.name}: ${entry.before} -> ${entry.after}`;
                case "moved":
                    return `  > ${entry.name}: position ${entry.before} -> ${entry.after}`;
            }
        })
        .join("\n");
};

export class SchemaMismatchError extends BursztynError {
    constructor(
        public readonly expectedHash: bigint,
        public readonly actualHash: bigint,
        public readonly diff: FieldDiff[],
        hint?: string,
    ) {
        const body = diff.length > 0 ? `\n${formatDiff(diff)}` : "";
        super(
            `Snapshot schema does not match this build (snapshot ${actualHash}, expected ${expectedHash}).${body}` +
                (hint ? `\n${hint}` : ""),
        );
    }
}

export class MigrationPathError extends BursztynError {
    constructor(
        public readonly from: number,
        public readonly to: number,
        detail: string,
    ) {
        super(`Cannot migrate snapshot from version ${from} to ${to}: ${detail}`);
    }
}

export class MigrationDataLossError extends BursztynError {
    constructor(
        public readonly field: string,
        public readonly step: string,
        bytesBefore: number,
    ) {
        super(
            `Migration ${step} would empty field "${field}" (${bytesBefore} bytes before, 0 after). ` +
                `Fill it in up(), or list it in \`drops\` to confirm the data is meant to go away.`,
        );
    }
}

export class CarryConflictError extends BursztynError {
    constructor(
        public readonly field: string,
        public readonly step: string,
    ) {
        super(
            `Migration ${step} wrote to "${field}", but that field was auto-carried unchanged from the ` +
                `previous snapshot, so those writes would be discarded. ` +
                `List it in \`rebuilds\` to take it over.`,
        );
    }
}
