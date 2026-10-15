// Runtime-owned deterministic module. Reproduce with scripts/vendor-voxel.mjs.
export class NpyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "NpyError";
    }
}
const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
const MAX_HEADER_BYTES = 1024 ** 2;
const MAX_ELEMENTS = 50_000_000;
/** Every integer in [-2^53, 2^53] converts to float64 exactly; beyond that, neighbours collapse. */
const EXACT = 2n ** 53n;
const DIMENSIONS = ["This array is a scalar; a voxel requires three dimensions.", "This array has one dimension; a voxel requires three.",
    "This array has two dimensions; a voxel requires three."];
/** Parses only the header; `bytes` may be a bounded prefix but must contain the whole header. */
export function parseNpyHeader(bytes) {
    if (bytes.length < 8 || MAGIC.some((byte, index) => bytes[index] !== byte))
        throw new NpyError("not-npy", "This file is not a NumPy .npy array; it lacks the NPY magic string.");
    const major = bytes[6], minor = bytes[7];
    if ((major !== 1 && major !== 2) || minor !== 0)
        throw new NpyError("unsupported-version", `Unsupported NPY format version ${major}.${minor}; save with NumPy format version 1 or 2.`);
    const prefix = major === 1 ? 10 : 12;
    if (bytes.length < prefix)
        throw new NpyError("header-invalid", "The NPY header is truncated.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
    if (length > MAX_HEADER_BYTES)
        throw new NpyError("header-invalid", `The NPY header declares ${length} bytes; headers over 1 MiB are not read.`);
    const dataOffset = prefix + length;
    if (bytes.length < dataOffset)
        throw new NpyError("header-invalid", "The NPY header is truncated.");
    // Latin-1 maps each byte to one code point; the grammar below admits ASCII only.
    let text = "";
    for (let at = prefix; at < dataOffset; at += 4096)
        text += String.fromCharCode(...bytes.subarray(at, Math.min(at + 4096, dataOffset)));
    const { descr, fortranOrder, shape } = parseDict(text);
    return { version: major === 1 ? 1 : 2, dataOffset, dtype: parseDescr(descr), fortranOrder, shape };
}
/** Reads `{'descr': str, 'fortran_order': bool, 'shape': tuple}` with nothing else, in any key order. */
function parseDict(text) {
    let at = 0, descr, fortranOrder, shape;
    const fail = () => {
        throw new NpyError("header-invalid", `The NPY header is not a plain dictionary of 'descr', 'fortran_order' and 'shape' (at character ${at}).`);
    };
    const space = () => { while (at < text.length && " \t\r\n".includes(text[at]))
        at++; };
    const take = (token) => { space(); if (!text.startsWith(token, at))
        return false; at += token.length; return true; };
    const expect = (token) => { if (!take(token))
        fail(); };
    const string = () => {
        space();
        const quote = text[at], end = quote === "'" || quote === '"' ? text.indexOf(quote, at + 1) : -1;
        if (end < 0)
            fail();
        const value = text.slice(at + 1, end);
        if (!/^[\x20-\x7e]*$/.test(value) || value.includes("\\"))
            fail();
        at = end + 1;
        return value;
    };
    const integer = /0|[1-9][0-9]*/y;
    const tuple = () => {
        const dims = [];
        expect("(");
        if (take(")"))
            return dims;
        for (;;) {
            space();
            integer.lastIndex = at;
            const match = integer.exec(text), value = Number(match?.[0]);
            if (!match || !Number.isSafeInteger(value))
                fail();
            dims.push(value);
            at = integer.lastIndex;
            if (take(",")) {
                if (take(")"))
                    return dims;
                continue;
            }
            expect(")");
            // `(5)` is a parenthesised integer in Python, not a tuple.
            return dims.length > 1 ? dims : fail();
        }
    };
    expect("{");
    while (!take("}")) {
        const key = string();
        expect(":");
        if (key === "descr" && descr === undefined) {
            space();
            if (text[at] === "[")
                throw new NpyError("unsupported-dtype", "Structured arrays are not supported; save one numeric field per array.");
            descr = string();
        }
        else if (key === "fortran_order" && fortranOrder === undefined)
            fortranOrder = take("True") ? true : take("False") ? false : fail();
        else if (key === "shape" && shape === undefined)
            shape = tuple();
        else
            fail();
        if (!take(",")) {
            expect("}");
            break;
        }
    }
    space();
    if (at !== text.length || descr === undefined || fortranOrder === undefined || shape === undefined)
        return fail();
    return { descr, fortranOrder, shape };
}
function parseDescr(descr) {
    const reject = (message) => { throw new NpyError("unsupported-dtype", message); };
    const order = /^[<>|=]/.test(descr) ? descr[0] : "", kind = descr.charAt(order.length), width = descr.slice(order.length + 1);
    if (kind === "O")
        reject("Object arrays are not supported; they require unpickling, which is never performed.");
    if (kind === "c")
        reject("Complex values are not supported.");
    if (kind === "b" || kind === "?")
        reject("Boolean arrays are not supported in this import profile; save them as uint8.");
    if (kind === "f" && width === "2")
        reject("float16 is not supported; convert to float32 or float64.");
    const supported = kind === "f" ? ["4", "8"] : kind === "i" || kind === "u" ? ["1", "2", "4", "8"] : [];
    if (!supported.includes(width))
        reject(`${descr} arrays are not supported; only integer and float32/float64 arrays can be imported.`);
    const size = Number(width);
    if (!(size === 1 ? ["<", ">", "|"] : ["<", ">"]).includes(order))
        reject("Byte order must be explicit ('<' or '>').");
    return { kind: kind, size, littleEndian: order !== ">", descr };
}
function elementCount(shape, maxElements) {
    let count = 1;
    for (const axis of shape) {
        count *= axis;
        if (!Number.isSafeInteger(count) || count > maxElements)
            throw new NpyError("too-large", `This array has ${shape.join(" × ")} cells, more than the import limit of ${maxElements}.`);
    }
    return count;
}
function checkPayload(header, totalBytes, count) {
    const expected = count * header.dtype.size, actual = totalBytes - header.dataOffset;
    if (actual < expected)
        throw new NpyError("payload-length", `The array payload is truncated: the header describes ${expected} bytes but ${Math.max(actual, 0)} follow it.`);
    if (actual > expected)
        throw new NpyError("payload-length", `The file has ${actual - expected} unexpected bytes after the ${expected}-byte array payload.`);
}
/** Checks that a header describes a supported 3D volume and that `totalBytes` is the exact file size. */
export function checkNpyVolume(header, totalBytes, maxElements = MAX_ELEMENTS) {
    const { shape } = header;
    if (shape.length !== 3)
        throw new NpyError("dimensions", DIMENSIONS[shape.length] ?? `This array has ${shape.length} dimensions; a voxel requires three.`);
    if (shape.includes(0))
        throw new NpyError("empty-axis", "Every axis must have at least one cell; singleton axes are allowed.");
    checkPayload(header, totalBytes, elementCount(shape, maxElements));
    return [shape[0], shape[1], shape[2]];
}
const TYPE_NAMES = { i: "int", u: "uint", f: "float" };
export function describeNpy({ dtype, shape, fortranOrder }) {
    const order = dtype.size === 1 ? "" : dtype.littleEndian ? " (little-endian)" : " (big-endian)";
    return `${TYPE_NAMES[dtype.kind]}${dtype.size * 8}${order}, ${shape.length ? shape.join(" × ") : "scalar"}, ${fortranOrder ? "Fortran" : "C"} order`;
}
const exact = (value) => {
    if (value > EXACT || value < -EXACT)
        throw new NpyError("integer-range", "Integer values beyond ±2^53 cannot be converted to float64 exactly; convert the array explicitly before import.");
    return Number(value);
};
const READERS = {
    i1: (view, at) => view.getInt8(at), u1: (view, at) => view.getUint8(at),
    i2: (view, at, le) => view.getInt16(at, le), u2: (view, at, le) => view.getUint16(at, le),
    i4: (view, at, le) => view.getInt32(at, le), u4: (view, at, le) => view.getUint32(at, le),
    i8: (view, at, le) => exact(view.getBigInt64(at, le)), u8: (view, at, le) => exact(view.getBigUint64(at, le)),
    f4: (view, at, le) => view.getFloat32(at, le), f8: (view, at, le) => view.getFloat64(at, le),
};
const payloadView = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
/** Decodes a complete file into canonical C order (Z fastest) float64. */
export function decodeNpyVolume(bytes, maxElements = MAX_ELEMENTS) {
    const header = parseNpyHeader(bytes), shape = checkNpyVolume(header, bytes.length, maxElements);
    const [nx, ny, nz] = shape, { kind, size, littleEndian } = header.dtype;
    const read = READERS[`${kind}${size}`], view = payloadView(bytes, header.dataOffset), values = new Float64Array(nx * ny * nz);
    if (!header.fortranOrder)
        for (let flat = 0; flat < values.length; flat++)
            values[flat] = read(view, flat * size, littleEndian);
    // Fortran order stores X fastest: element (i, j, k) is at flat i + nx * (j + ny * k).
    else
        for (let k = 0, at = 0; k < nz; k++)
            for (let j = 0; j < ny; j++)
                for (let i = 0; i < nx; i++, at += size)
                    values[(i * ny + j) * nz + k] = read(view, at, littleEndian);
    return { header, shape, values };
}
/** Decodes a published member of exactly the expected descriptor and shape into a fresh typed array in C order. */
export function decodeNpyArray(bytes, expected) {
    const header = parseNpyHeader(bytes), { shape } = header;
    if (header.dtype.descr !== expected.descr)
        throw new NpyError("unsupported-dtype", `Expected a ${expected.descr} array but found ${header.dtype.descr}.`);
    if (header.fortranOrder)
        throw new NpyError("header-invalid", "Expected a C-order array but found Fortran order.");
    if (shape.length !== expected.shape.length || shape.some((axis, index) => axis !== expected.shape[index])) {
        throw new NpyError("dimensions", `Expected shape (${expected.shape.join(", ")}) but found (${shape.join(", ")}).`);
    }
    const count = elementCount(shape, Number.MAX_SAFE_INTEGER);
    checkPayload(header, bytes.length, count);
    // Copy rather than view: callers may hold a pooled or unaligned buffer.
    if (expected.descr === "|u1")
        return new Uint8Array(bytes.subarray(header.dataOffset));
    const values = expected.descr === "<u4" ? new Uint32Array(count) : new Float64Array(count), read = READERS[`${header.dtype.kind}${header.dtype.size}`];
    const view = payloadView(bytes, header.dataOffset);
    for (let index = 0; index < count; index++)
        values[index] = read(view, index * header.dtype.size, true);
    return values;
}
/** Writes a version 1.0, C-order, little-endian file whose header matches NumPy's own layout and 64-byte alignment. */
export function encodeNpy(values, shape) {
    const size = values.BYTES_PER_ELEMENT, descr = size === 8 ? "<f8" : size === 4 ? "<u4" : "|u1";
    if (!shape.every((axis) => Number.isSafeInteger(axis) && axis >= 0) || shape.reduce((product, axis) => product * axis, 1) !== values.length) {
        throw new NpyError("dimensions", `Shape (${shape.join(", ")}) does not describe ${values.length} values.`);
    }
    const dict = new TextEncoder().encode(`{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`);
    const headerLength = dict.length + 1 + (64 - (10 + dict.length + 1) % 64) % 64;
    if (headerLength > 0xffff)
        throw new NpyError("header-invalid", "The NPY header exceeds the 65535-byte limit of format version 1.0.");
    const dataOffset = 10 + headerLength, out = new Uint8Array(dataOffset + values.byteLength);
    out.set([...MAGIC, 1, 0, headerLength & 0xff, headerLength >> 8]);
    out.set(dict, 10);
    out.fill(0x20, 10 + dict.length, dataOffset - 1);
    out[dataOffset - 1] = 0x0a;
    const view = new DataView(out.buffer, dataOffset);
    if (size === 1)
        out.set(values, dataOffset);
    else if (size === 4)
        for (let index = 0; index < values.length; index++)
            view.setUint32(index * 4, values[index], true);
    else
        for (let index = 0; index < values.length; index++)
            view.setFloat64(index * 8, values[index], true);
    return out;
}
