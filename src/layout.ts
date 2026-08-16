import { hashStringToBigint } from "./hash.ts";
import type { Field, SchemaShape } from "./types.ts";

export interface FieldLayout {
    name: string;
    field: Field<any, any>;
    signature: string;
    startSectionId: number;
    sectionCount: number;
}

export interface CompiledSchema<S extends SchemaShape = SchemaShape> {
    fields: S;
    layout: FieldLayout[];
    layoutByName: Record<string, FieldLayout>;
    totalSections: number;
    hash: bigint;
}

export const compileSchema = <S extends SchemaShape>(fields: S): CompiledSchema<S> => {
    const layout: FieldLayout[] = [];
    const layoutByName: Record<string, FieldLayout> = {};
    let nextSection = 0;
    let hash = 0n;

    for (const name of Object.keys(fields) as (keyof S & string)[]) {
        const field = fields[name];
        const signature = field.signature();
        const entry: FieldLayout = {
            name,
            field,
            signature,
            startSectionId: nextSection,
            sectionCount: field.sectionCount,
        };
        layout.push(entry);
        layoutByName[name] = entry;

        hash = BigInt.asUintN(
            64,
            hash + hashStringToBigint(`${name}:${signature}:${nextSection}:${field.sectionCount}`),
        );

        nextSection += field.sectionCount;
    }

    return { fields, layout, layoutByName, totalSections: nextSection, hash };
};
