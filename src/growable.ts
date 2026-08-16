import type { AnyTypedArray, TypedArrayConstructor } from "./types.ts";

// Inclusive value ranges for the integer typed arrays. Float arrays are absent:
// they accept anything, so a lookup miss means "no range check".
const INTEGER_RANGES: Record<string, [min: number, max: number]> = {
    Int8Array: [-128, 127],
    Uint8Array: [0, 255],
    Uint8ClampedArray: [0, 255],
    Int16Array: [-32768, 32767],
    Uint16Array: [0, 65535],
    Int32Array: [-2147483648, 2147483647],
    Uint32Array: [0, 4294967295],
};

export const rangeOf = (ctor: TypedArrayConstructor): [min: number, max: number] =>
    INTEGER_RANGES[ctor.name] ?? [-Infinity, Infinity];

const INITIAL_CAPACITY = 8;

/**
 * An append-only typed array that grows geometrically.
 *
 * Builders used to accumulate into a plain `number[]` and convert once at
 * `finalize()`. That costs ~8 bytes per element plus array overhead while
 * building — and doubles at the conversion, since the source array is still
 * live. Writing straight into the destination type means a Uint8Array column
 * costs one byte per element the whole way through, with no final copy.
 *
 * Values are range-checked on the way in, so an overflow throws at the `push`
 * that caused it instead of at `build()`.
 */
export class NumberBuffer {
    private data: AnyTypedArray;
    private len = 0;
    private readonly min: number;
    private readonly max: number;

    constructor(
        private readonly ctor: TypedArrayConstructor,
        private readonly label: string,
        capacity = 0,
    ) {
        this.data = new ctor(capacity) as AnyTypedArray;
        const [min, max] = rangeOf(ctor);
        this.min = min;
        this.max = max;
    }

    get length(): number {
        return this.len;
    }

    /** A live view of the elements written so far. Not a copy. */
    get view(): AnyTypedArray {
        return this.data.subarray(0, this.len) as AnyTypedArray;
    }

    private grow(needed: number) {
        let capacity = this.data.length === 0 ? INITIAL_CAPACITY : this.data.length;
        while (capacity < needed) capacity *= 2;

        const next = new this.ctor(capacity) as AnyTypedArray;
        (next as Uint8Array).set(this.data.subarray(0, this.len) as Uint8Array);
        this.data = next;
    }

    reserve(extra: number) {
        const needed = this.len + extra;
        if (needed > this.data.length) this.grow(needed);
    }

    push(value: number) {
        if (value < this.min || value > this.max) this.reject(value);
        if (this.len === this.data.length) this.grow(this.len + 1);
        (this.data as Uint8Array)[this.len++] = value;
    }

    /** Bulk append. One capacity check for the whole run instead of one per value. */
    pushMany(values: ArrayLike<number>) {
        const count = values.length;
        this.reserve(count);

        const data = this.data as Uint8Array;
        const { min, max } = this;
        let at = this.len;

        for (let i = 0; i < count; i++) {
            const value = values[i];
            if (value < min || value > max) {
                this.len = at;
                this.reject(value);
            }
            data[at++] = value;
        }

        this.len = at;
    }

    clear() {
        this.len = 0;
    }

    private reject(value: number): never {
        throw new RangeError(
            `${this.label}: value ${value} at index ${this.len} does not fit ${this.ctor.name} ` +
                `[${this.min}, ${this.max}]`,
        );
    }
}

/**
 * The same growth strategy for u32 lists that never need a range check —
 * offsets, section pointers, hash table columns. Skipping the bounds test is
 * worth it on the paths that push once per entry of an index.
 */
export class U32Buffer {
    private data: Uint32Array;
    private len = 0;

    constructor(capacity = 0) {
        this.data = new Uint32Array(capacity);
    }

    get length(): number {
        return this.len;
    }

    get view(): Uint32Array {
        return this.data.subarray(0, this.len);
    }

    at(index: number): number {
        return this.data[index];
    }

    last(): number {
        return this.len === 0 ? -1 : this.data[this.len - 1];
    }

    push(value: number) {
        if (this.len === this.data.length) {
            const capacity = this.len === 0 ? INITIAL_CAPACITY : this.len * 2;
            const next = new Uint32Array(capacity);
            next.set(this.data.subarray(0, this.len));
            this.data = next;
        }
        this.data[this.len++] = value;
    }
}
