import { BursztynError } from "./errors";
import { assembleSnapshot, type EmittedField } from "./format";
import type { CompiledSchema } from "./layout";
import { StringInterner } from "./strings";
import type { AnyTypedArray, Builders, BuilderContext, SchemaShape } from "./types";

const asBytes = (data: AnyTypedArray): Uint8Array =>
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

export class SnapshotBuilder<S extends SchemaShape = SchemaShape> {
    public readonly builders: Builders<S> & Record<string, any>;
    public readonly strings: StringInterner;
    private readonly carried = new Map<string, Uint8Array[]>();

    constructor(
        public readonly compiled: CompiledSchema<S>,
        public readonly version: number = 0,
        strings?: StringInterner,
    ) {
        this.strings = strings ?? new StringInterner();
        const ctx: BuilderContext = { strings: this.strings };

        const builders: Record<string, unknown> = {};
        for (const entry of this.compiled.layout) {
            builders[entry.name] = entry.field.createBuilder(ctx);
        }

        this.builders = builders as Builders<S> & Record<string, any>;
    }

    carry(name: string, sections: Uint8Array[]) {
        const entry = this.compiled.layoutByName[name];
        if (!entry) throw new BursztynError(`Cannot carry unknown field "${name}".`);
        if (sections.length !== entry.sectionCount) {
            throw new BursztynError(
                `Cannot carry "${name}": got ${sections.length} sections, schema expects ${entry.sectionCount}.`,
            );
        }
        this.carried.set(name, sections);
    }

    isCarried(name: string): boolean {
        return this.carried.has(name);
    }

    emit(): EmittedField[] {
        return this.compiled.layout.map((entry) => {
            const carried = this.carried.get(entry.name);
            if (carried) {
                return { name: entry.name, signature: entry.signature, sections: carried };
            }

            const sections = entry.field.finalize((this.builders as any)[entry.name], entry.name);
            if (sections.length !== entry.sectionCount) {
                throw new BursztynError(
                    `Field "${entry.name}" emitted ${sections.length} sections, expected ${entry.sectionCount}.`,
                );
            }

            return {
                name: entry.name,
                signature: entry.signature,
                sections: sections.map((section) => asBytes(section.data)),
            };
        });
    }

    build(): Uint8Array {
        return assembleSnapshot(this.emit(), this.compiled.hash, this.version);
    }

    buildShared(): SharedArrayBuffer {
        const bytes = assembleSnapshot(
            this.emit(),
            this.compiled.hash,
            this.version,
            (byteLength) => new SharedArrayBuffer(byteLength),
        );
        return bytes.buffer as SharedArrayBuffer;
    }
}
