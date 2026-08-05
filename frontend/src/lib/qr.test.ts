/** Structural tests for the hand-rolled QR generator.
 *
 *  These pin the parts of the spec a decoder relies on to *find* the symbol:
 *  size, finder patterns, timing patterns, the dark module. They do not prove
 *  the payload decodes — that needs a real scanner, and is worth doing by eye
 *  once against a phone camera before relying on the QR path.
 */
import {describe, expect, it} from 'vitest';
import {qrDataUrl, qrMatrix} from './qr';

const CODE = '482711936052';

/** A finder pattern is a 7x7 dark ring with a 3x3 dark core. */
function finderAt(m: boolean[][], r0: number, c0: number): boolean {
    for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
            const onRing = r === 0 || r === 6 || c === 0 || c === 6;
            const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            if (m[r0 + r][c0 + c] !== (onRing || inCore)) return false;
        }
    }
    return true;
}

describe('qrMatrix', () => {
    it('picks version 1 (21x21) for a 12-digit code', () => {
        const m = qrMatrix(CODE);
        expect(m.length).toBe(21);
        expect(m[0].length).toBe(21);
    });

    it('places all three finder patterns', () => {
        const m = qrMatrix(CODE);
        expect(finderAt(m, 0, 0)).toBe(true);
        expect(finderAt(m, 0, m.length - 7)).toBe(true);
        expect(finderAt(m, m.length - 7, 0)).toBe(true);
    });

    it('alternates the timing patterns', () => {
        const m = qrMatrix(CODE);
        for (let i = 8; i < m.length - 8; i++) {
            expect(m[6][i]).toBe(i % 2 === 0);
            expect(m[i][6]).toBe(i % 2 === 0);
        }
    });

    it('sets the always-dark module', () => {
        const m = qrMatrix(CODE);
        expect(m[m.length - 8][8]).toBe(true);
    });

    /** A symbol that is nearly all light or all dark means the data or mask
     *  step silently did nothing. */
    it('produces a balanced mix of light and dark', () => {
        const m = qrMatrix(CODE);
        const dark = m.flat().filter(Boolean).length;
        const ratio = dark / (m.length * m.length);
        expect(ratio).toBeGreaterThan(0.3);
        expect(ratio).toBeLessThan(0.7);
    });

    it('grows the symbol for longer payloads', () => {
        const peerId = '12D3KooWQ7xJ4kR2mN8pL5vX3wY6zA9bC1dE4fG7hJ0kL2mN5pQ';
        expect(qrMatrix(peerId).length).toBeGreaterThan(qrMatrix(CODE).length);
    });

    it('encodes a full peer id without throwing', () => {
        expect(() => qrMatrix('12D3KooWQ7xJ4kR2mN8pL5vX3wY6zA9bC1dE4fG7hJ0kL2mN5pQ')).not.toThrow();
    });

    it('rejects payloads beyond version 10', () => {
        expect(() => qrMatrix('x'.repeat(300))).toThrow(/too large/);
    });

    it('is deterministic', () => {
        expect(qrMatrix(CODE)).toEqual(qrMatrix(CODE));
    });
});

describe('qrDataUrl', () => {
    it('returns a decodable svg data url', () => {
        const url = qrDataUrl(CODE);
        expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
        const svg = atob(url.slice('data:image/svg+xml;base64,'.length));
        expect(svg).toContain('<svg');
        expect(svg).toContain('viewBox');
    });

    it('scales with the scale factor', () => {
        expect(qrDataUrl(CODE, 8).length).toBeGreaterThan(qrDataUrl(CODE, 2).length);
    });
});
