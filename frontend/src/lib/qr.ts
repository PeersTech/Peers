/** Minimal QR code generator, byte mode, error-correction level L.
 *
 *  Hand-rolled rather than pulled from npm: a peer code is identity-adjacent
 *  data, and this app's whole premise is not trusting third parties with it.
 *  ~200 lines of well-specified math beats a transitive dependency tree.
 *
 *  Supports versions 1–10 (up to 271 bytes at level L), which comfortably
 *  covers a 12-digit code or a full 52-char peer id.
 */

/** Galois field GF(256) log/antilog tables for Reed-Solomon. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d; // QR's primitive polynomial
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon error-correction codewords for `data`. */
function ecCodewords(data: Uint8Array, ecLen: number): Uint8Array {
    // Generator polynomial for `ecLen` correction bytes.
    let gen = new Uint8Array([1]);
    for (let i = 0; i < ecLen; i++) {
        const next = new Uint8Array(gen.length + 1);
        for (let j = 0; j < gen.length; j++) {
            next[j] ^= gen[j];
            next[j + 1] ^= mul(gen[j], EXP[i]);
        }
        gen = next;
    }
    const rem = new Uint8Array(ecLen);
    for (const byte of data) {
        const factor = byte ^ rem[0];
        rem.copyWithin(0, 1);
        rem[ecLen - 1] = 0;
        for (let j = 0; j < ecLen; j++) rem[j] ^= mul(gen[j + 1], factor);
    }
    return rem;
}

/** Total data codewords and EC-per-block, level L, versions 1–10. */
const CAPACITY_L: Record<number, {data: number; ecPerBlock: number; blocks: number}> = {
    1: {data: 19, ecPerBlock: 7, blocks: 1},
    2: {data: 34, ecPerBlock: 10, blocks: 1},
    3: {data: 55, ecPerBlock: 15, blocks: 1},
    4: {data: 80, ecPerBlock: 20, blocks: 1},
    5: {data: 108, ecPerBlock: 26, blocks: 1},
    6: {data: 136, ecPerBlock: 18, blocks: 2},
    7: {data: 156, ecPerBlock: 20, blocks: 2},
    8: {data: 194, ecPerBlock: 24, blocks: 2},
    9: {data: 232, ecPerBlock: 30, blocks: 2},
    10: {data: 274, ecPerBlock: 18, blocks: 4},
};

const ALIGNMENT: Record<number, number[]> = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** Format-info bits for level L with mask `m`, BCH-encoded and XOR-masked. */
function formatBits(mask: number): number {
    const data = (0b01 << 3) | mask; // 01 = level L
    let rem = data;
    for (let i = 0; i < 10; i++) {
        rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
}

/** Renders `text` as a QR matrix of booleans (true = dark module). */
export function qrMatrix(text: string): boolean[][] {
    const bytes = new TextEncoder().encode(text);

    // Smallest version that fits: 4 mode bits + 8/16 length bits + payload.
    let version = 1;
    while (version <= 10) {
        const lenBits = version < 10 ? 8 : 16;
        const need = Math.ceil((4 + lenBits + bytes.length * 8) / 8);
        if (need <= CAPACITY_L[version].data) break;
        version++;
    }
    if (version > 10) throw new Error("payload too large for QR versions 1-10");

    const cap = CAPACITY_L[version];
    const size = version * 4 + 17;

    // ── Bitstream: mode, length, payload, terminator, pad ──
    const bits: number[] = [];
    const push = (val: number, len: number) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, cap.data * 8 - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    const pad = [0xec, 0x11];
    for (let i = 0; bits.length < cap.data * 8; i++) push(pad[i % 2], 8);

    const dataBytes = new Uint8Array(cap.data);
    for (let i = 0; i < cap.data; i++) {
        for (let j = 0; j < 8; j++) dataBytes[i] |= bits[i * 8 + j] << (7 - j);
    }

    // ── Split into blocks, compute EC, interleave ──
    const perBlock = Math.floor(cap.data / cap.blocks);
    const extra = cap.data % cap.blocks;
    const blocks: Uint8Array[] = [];
    const ecBlocks: Uint8Array[] = [];
    let off = 0;
    for (let i = 0; i < cap.blocks; i++) {
        const len = perBlock + (i >= cap.blocks - extra ? 1 : 0);
        const blk = dataBytes.slice(off, off + len);
        off += len;
        blocks.push(blk);
        ecBlocks.push(ecCodewords(blk, cap.ecPerBlock));
    }
    const final: number[] = [];
    const maxLen = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) {
        for (const b of blocks) if (i < b.length) final.push(b[i]);
    }
    for (let i = 0; i < cap.ecPerBlock; i++) {
        for (const e of ecBlocks) final.push(e[i]);
    }

    // ── Matrix: function patterns first, then data ──
    const m: (boolean | null)[][] = Array.from({length: size}, () =>
        Array<boolean | null>(size).fill(null),
    );

    const setFinder = (row: number, col: number) => {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const rr = row + r;
                const cc = col + c;
                if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
                const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
                const dark =
                    inRing &&
                    ((r === 0 || r === 6 || c === 0 || c === 6) ||
                        (r >= 2 && r <= 4 && c >= 2 && c <= 4));
                m[rr][cc] = dark;
            }
        }
    };
    setFinder(0, 0);
    setFinder(0, size - 7);
    setFinder(size - 7, 0);

    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
        m[6][i] = i % 2 === 0;
        m[i][6] = i % 2 === 0;
    }

    // Alignment patterns (skipping those overlapping finders).
    const centers = ALIGNMENT[version];
    for (const r of centers) {
        for (const c of centers) {
            if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) {
                continue;
            }
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    m[r + dr][c + dc] =
                        Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
                }
            }
        }
    }

    m[size - 8][8] = true; // dark module

    // Reserve format/version areas so data placement skips them.
    const reserved = new Set<string>();
    for (let i = 0; i < 9; i++) {
        reserved.add(`8,${i}`);
        reserved.add(`${i},8`);
    }
    for (let i = 0; i < 8; i++) {
        reserved.add(`8,${size - 1 - i}`);
        reserved.add(`${size - 1 - i},8`);
    }
    if (version >= 7) {
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 3; j++) {
                reserved.add(`${i},${size - 11 + j}`);
                reserved.add(`${size - 11 + j},${i}`);
            }
        }
    }

    // ── Place data in the zigzag pattern, applying mask 0 ──
    let bitIdx = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--; // skip the vertical timing column
        for (let i = 0; i < size; i++) {
            const row = upward ? size - 1 - i : i;
            for (const c of [col, col - 1]) {
                if (m[row][c] !== null || reserved.has(`${row},${c}`)) continue;
                const byte = final[bitIdx >>> 3];
                const bit = byte === undefined ? 0 : (byte >>> (7 - (bitIdx & 7))) & 1;
                bitIdx++;
                // Mask 0: invert where (row + col) is even.
                m[row][c] = (bit ^ ((row + c) % 2 === 0 ? 1 : 0)) === 1;
            }
        }
        upward = !upward;
    }

    // ── Format and version information ──
    const fmt = formatBits(0);
    for (let i = 0; i < 15; i++) {
        const bit = ((fmt >>> i) & 1) === 1;
        if (i < 6) m[i][8] = bit;
        else if (i < 8) m[i + 1][8] = bit;
        else if (i === 8) m[8][7] = bit;
        else m[8][14 - i] = bit;

        if (i < 8) m[8][size - 1 - i] = bit;
        else m[size - 15 + i][8] = bit;
    }
    if (version >= 7) {
        const vb = versionBits(version);
        for (let i = 0; i < 18; i++) {
            const bit = ((vb >>> i) & 1) === 1;
            m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
            m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
        }
    }

    return m.map((row) => row.map((cell) => cell === true));
}

/** Renders `text` as an SVG data URL, sized for an <img> tag. */
export function qrDataUrl(text: string, scale = 4, quiet = 4): string {
    const m = qrMatrix(text);
    const size = m.length;
    const dim = (size + quiet * 2) * scale;
    // One path for every dark module beats one <rect> each — the string stays
    // small enough to sit comfortably in a data URL.
    let d = "";
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (m[r][c]) {
                d += `M${(c + quiet) * scale},${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
            }
        }
    }
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}">` +
        `<rect width="${dim}" height="${dim}" fill="#f0e6d2"/>` +
        `<path d="${d}" fill="#17150f"/></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}
