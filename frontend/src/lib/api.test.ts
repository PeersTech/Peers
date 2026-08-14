import {describe, expect, it} from 'vitest';
import {bytesToBase64, dataUrl, mentionsMe, parseMentions} from './api';

describe('avatar data helpers', () => {
    it('encodes bytes and adds the PNG data prefix', () => {
        expect(bytesToBase64([0, 1, 2, 253, 254, 255])).toBe('AAEC/f7/');
        expect(dataUrl([137, 80, 78, 71])).toBe('data:image/png;base64,iVBORw==');
    });

    it('crosses the chunk boundary without truncating data', () => {
        const bytes = Array.from({length: 0x8000 + 17}, (_, index) => index % 256);
        const encoded = bytesToBase64(bytes);
        const decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
        expect(Array.from(decoded)).toEqual(bytes);
    });
});

describe('mentions', () => {
    const peerId = '12D3KooWQ7xJ4kR2mN8pL5vX3wY6zA9bC1dE4fG7hJ0kL';
    const contacts = [{peerId, name: 'JuicyPear'}];

    it('finds and resolves full peer-id mentions', () => {
        const found = parseMentions(`hello @${peerId}`, contacts);
        expect(found).toHaveLength(1);
        expect(found[0].member?.name).toBe('JuicyPear');
    });

    it('distinguishes mentions of me from ordinary text', () => {
        expect(mentionsMe(`hello @${peerId}`, peerId)).toBe(true);
        expect(mentionsMe(`hello ${peerId}`, peerId)).toBe(false);
    });
});
