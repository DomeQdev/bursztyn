import { FormatError } from "./errors.ts";
import type { ManifestEntry } from "./format.ts";

export const JOURNAL_FORMAT = 1;

export interface JournalEntry {
    version: number;
    id: string;
    hash: string;
    createdAt: string;
}

export interface Journal {
    format: number;
    entries: JournalEntry[];
}

export interface SchemaSnapshot {
    version: number;
    id: string;
    hash: string;
    fields: [name: string, signature: string, sectionCount: number][];
}

export const emptyJournal = (): Journal => ({ format: JOURNAL_FORMAT, entries: [] });

export const parseJournal = (text: string): Journal => {
    const journal = JSON.parse(text) as Journal;
    if (journal.format !== JOURNAL_FORMAT) {
        throw new FormatError(
            `_journal.json is format ${journal.format}, this build reads ${JOURNAL_FORMAT}.`,
        );
    }
    return journal;
};

export const snapshotManifest = (snapshot: SchemaSnapshot): ManifestEntry[] =>
    snapshot.fields.map(([name, signature, sectionCount]) => ({ name, signature, sectionCount }));

export const migrationNumber = (version: number): string => String(version).padStart(4, "0");

export const journalPath = (out: string) => `${out}/meta/_journal.json`;
export const snapshotPath = (out: string, version: number) =>
    `${out}/meta/${migrationNumber(version)}_snapshot.json`;
export const migrationPath = (out: string, version: number, name: string) =>
    `${out}/${migrationNumber(version)}_${name}.ts`;
export const barrelPath = (out: string) => `${out}/index.ts`;
