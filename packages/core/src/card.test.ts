import {describe, expect, it} from 'vitest';
import {Identity} from './identity.js';
import {
  cardFromEnvelope,
  defaultDisplayName,
  PeerCard,
  SessionDir,
  SignedProfile,
} from './card.js';

function pair(): [Identity, Identity] {
  return [Identity.random(), Identity.random()];
}

describe('peer cards', () => {
  it('verifies a signed card', () => {
    const [a] = pair();
    expect(PeerCard.verify(PeerCard.sign(a))).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const [a] = pair();
    const card = PeerCard.sign(a);
    card.sig[0]! ^= 0xff;
    expect(PeerCard.verify(card)).toBe(false);
  });

  it('parses from an envelope without decrypting', () => {
    const [a, b] = pair();
    const dir = new SessionDir(a);
    const payload = dir.seal([b.xPublic()], new TextEncoder().encode('ch'), new TextEncoder().encode('hi'));
    const card = cardFromEnvelope(payload);
    expect(card.edPub).toEqual(a.edPublic());
  });
});

describe('signed profiles', () => {
  it('signs and verifies', () => {
    const [a] = pair();
    const p = SignedProfile.sign(a, 'JuicyPear', 'hello world', null);
    SignedProfile.verify(p);
    expect(p.peerId).toBe(a.peerId);
    expect(p.displayName).toBe('JuicyPear');
    expect(p.about).toBe('hello world');
  });

  it('empty name falls back to the fun auto-name', () => {
    const [a] = pair();
    const p = SignedProfile.sign(a, '   ', '', null);
    expect(p.displayName).toBe(defaultDisplayName(a.peerIdBytes));
    SignedProfile.verify(p);
  });

  it('tampered profile rejected', () => {
    const [a] = pair();
    const p = SignedProfile.sign(a, 'JuicyPear', 'about', null);
    const tampered = {...p, about: 'rewritten'};
    expect(() => SignedProfile.verify(tampered)).toThrow();
  });

  it('profile bound to its peer id', () => {
    const [a, b] = pair();
    const p = SignedProfile.sign(a, 'JuicyPear', '', null);
    const stolen = {...p, peerId: b.peerId};
    expect(() => SignedProfile.verify(stolen)).toThrow();
  });

  it('trims display name and about', () => {
    const [a] = pair();
    const p = SignedProfile.sign(a, '  Bob  ', ' about ', null);
    expect(p.displayName).toBe('Bob');
    expect(p.about).toBe('about');
  });
});

describe('session directory (E2E envelopes)', () => {
  it('A to B round trip; B can reply afterwards', () => {
    const [a, b] = pair();
    const da = new SessionDir(a);
    const db = new SessionDir(b);
    const payload = da.seal(
      [b.xPublic()],
      new TextEncoder().encode('channel/general'),
      new TextEncoder().encode('hello b'),
    );
    expect(new TextDecoder().decode(db.open(new TextEncoder().encode('channel/general'), payload))).toBe(
      'hello b',
    );
    // B cached A's key from the verified card, so B can reply.
    const reply = db.seal([a.xPublic()], new TextEncoder().encode('channel/general'), new TextEncoder().encode('sup'));
    expect(new TextDecoder().decode(da.open(new TextEncoder().encode('channel/general'), reply))).toBe('sup');
  });

  it('third party cannot open', () => {
    const [a, b] = pair();
    const c = Identity.random();
    const da = new SessionDir(a);
    const dc = new SessionDir(c);
    const payload = da.seal([b.xPublic()], new TextEncoder().encode('ch'), new TextEncoder().encode('secret'));
    let notAddressed = false;
    try {
      dc.open(new TextEncoder().encode('ch'), payload);
    } catch (e) {
      notAddressed = String((e as Error).message).includes('not addressed') || String((e as Error).message).includes('authentication');
    }
    expect(notAddressed).toBe(true);
  });

  it('wrong aad rejected', () => {
    const [a, b] = pair();
    const da = new SessionDir(a);
    const db = new SessionDir(b);
    const payload = da.seal([b.xPublic()], new TextEncoder().encode('channel/one'), new TextEncoder().encode('secret'));
    expect(() => db.open(new TextEncoder().encode('channel/other'), payload)).toThrow();
  });

  it('replay rejected across copies', () => {
    const [a, b] = pair();
    const da = new SessionDir(a);
    const db = new SessionDir(b);
    const first = da.seal([b.xPublic()], new TextEncoder().encode('ch'), new TextEncoder().encode('first'));
    db.open(new TextEncoder().encode('ch'), first);
    const second = da.seal([b.xPublic()], new TextEncoder().encode('ch'), new TextEncoder().encode('second'));
    db.open(new TextEncoder().encode('ch'), second);
    // Same envelope replayed — even after newer messages opened.
    expect(() => db.open(new TextEncoder().encode('ch'), first)).toThrow(/replay/i);
  });

  it('multi-recipient: both recipients open their copy', () => {
    const [a, b] = pair();
    const c = Identity.random();
    const da = new SessionDir(a);
    const db = new SessionDir(b);
    const dc = new SessionDir(c);
    const payload = da.seal(
      [b.xPublic(), c.xPublic()],
      new TextEncoder().encode('ch'),
      new TextEncoder().encode('both'),
    );
    expect(new TextDecoder().decode(db.open(new TextEncoder().encode('ch'), payload))).toBe('both');
    expect(new TextDecoder().decode(dc.open(new TextEncoder().encode('ch'), payload))).toBe('both');
  });

  it('tampered envelope rejected', () => {
    const [a, b] = pair();
    const da = new SessionDir(a);
    const db = new SessionDir(b);
    const payload = da.seal([b.xPublic()], new TextEncoder().encode('ch'), new TextEncoder().encode("don't touch"));
    payload[payload.length - 1]! ^= 0xff;
    expect(() => db.open(new TextEncoder().encode('ch'), payload)).toThrow();
  });

  it('export/restore round-trips sessions and contacts', () => {
    const [a, b] = pair();
    const da = new SessionDir(a);
    const payload = da.seal([b.xPublic()], new TextEncoder().encode('ch'), new TextEncoder().encode('one'));
    void payload;
    const snapshot = da.export();
    const revived = SessionDir.restore(snapshot, a);
    expect(revived.recipientKeys()).toEqual(da.recipientKeys());
  });

  it('sealing with no recipients is an error', () => {
    const [a] = pair();
    const da = new SessionDir(a);
    expect(() =>
      da.seal([], new Uint8Array(0), new TextEncoder().encode('x')),
    ).toThrow(/recipient/i);
  });
});
