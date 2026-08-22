import {base32nopad} from '@scure/base';
import {describe, expect, it} from 'vitest';
import {Identity} from './identity.js';
import {defaultDisplayName} from './card.js';

describe('identity', () => {
  it('same entropy rebuilds the same peer id — the phrase IS the identity', () => {
    const e = new Uint8Array(16).fill(9);
    const a = Identity.fromEntropy(e);
    const b = Identity.fromEntropy(e);
    expect(a.peerId).toBe(b.peerId);
    expect(a.xPublic()).toEqual(b.xPublic());
    expect(a.fingerprint()).toBe(b.fingerprint());
  });

  it('different identities differ', () => {
    const a = Identity.random();
    const b = Identity.random();
    expect(a.peerId).not.toBe(b.peerId);
  });

  it('peer ids use the libp2p ed25519 form (12D3KooW…)', () => {
    const id = Identity.random();
    // identity multihash over protobuf-encoded ed25519 key, base58btc
    expect(id.peerId.startsWith('12D3KooW')).toBe(true);
  });

  it('marshal round-trips', () => {
    const id = Identity.random();
    const back = Identity.unmarshal(id.marshal());
    expect(back.peerId).toBe(id.peerId);
    expect(back.xSecret).toEqual(id.xSecret);
    expect(back.fingerprint()).toBe(id.fingerprint());
  });

  it('fingerprint is SHA-256 of both pubs as grouped base32 (52 chars)', () => {
    const fp = Identity.random().fingerprint();
    const plain = fp.replaceAll(' ', '');
    expect(plain).toHaveLength(52);
    expect(base32nopad.decode(plain)).toHaveLength(32);
    // groups of four separated by spaces: "XXXX XXXX …"
    for (const group of fp.split(' ')) expect(group).toHaveLength(4);
  });

  it('signs and verifies with the ed25519 key', () => {
    const id = Identity.random();
    const msg = new TextEncoder().encode('hello');
    const sig = id.sign(msg);
    expect(id.verify(msg, sig)).toBe(true);
    sig[0]! ^= 0xff;
    expect(id.verify(msg, sig)).toBe(false);
  });

  it('short form elides the middle of long peer ids', () => {
    const short = Identity.random().peerIdShort();
    expect(short.length).toBeLessThanOrEqual(13);
    expect(short.includes('…')).toBe(true);
  });
});

describe('default display name', () => {
  it('is stable per peer id', () => {
    const id = Identity.random();
    expect(defaultDisplayName(id.peerIdBytes)).toBe(defaultDisplayName(id.peerIdBytes));
  });

  it('is a fun Adjective+Noun pair', () => {
    const name = defaultDisplayName(Identity.random().peerIdBytes);
    expect(name).toMatch(/^(Juicy|Cosmic|Turbo|Silky|Crispy|Golden|Mellow|Fuzzy|Swift|Velvet|Spicy|Breezy)(Pear|Comet|Duck|Ghost|Taco|Beetle|Cloud|Fox|Cactus|Orbit|Llama|Waffle)$/);
  });
});
