import {describe, expect, it} from 'vitest';
import {Identity} from './identity.js';
import {FriendNotice, friendRequestTopic} from './friend.js';

describe('FriendNotice — signed request/accept handshake', () => {
  it('signs and verifies a notice round trip', () => {
    const alice = Identity.random();
    const bob = Identity.random();

    const req = FriendNotice.sign(alice, 'request', bob.peerId);
    expect(req.version).toBe(1);
    expect(req.from).toBe(alice.peerId);
    expect(req.to).toBe(bob.peerId);
    expect(req.card.x25519Pub).toEqual(alice.xPublic());

    FriendNotice.verify(req);
  });

  it('rejects tampered payload', () => {
    const alice = Identity.random();
    const bob = Identity.random();
    const req = FriendNotice.sign(alice, 'request', bob.peerId);

    const tampered: typeof req = {...req, to: Identity.random().peerId};
    expect(() => FriendNotice.verify(tampered)).toThrow(/signature/);
  });

  it('rejects swapped sender (peer id mismatch)', () => {
    const alice = Identity.random();
    const eve = Identity.random();
    const req = FriendNotice.sign(alice, 'request', Identity.random().peerId);
    // Eve reuses Alice's signed bytes but claims her own peer id.
    const forged: typeof req = {
      ...req,
      from: eve.peerId,
    };
    expect(() => FriendNotice.verify(forged)).toThrow();
  });

  it('rejects when from does not match expected sender', () => {
    const alice = Identity.random();
    const mallory = Identity.random();
    const req = FriendNotice.sign(mallory, 'accept', alice.peerId);

    // Bob asked for an accept specifically from Alice.
    expect(() => FriendNotice.verify(req, alice.peerId)).toThrow(/unexpected sender/);
    FriendNotice.verify(req, mallory.peerId); // correct expectation passes
  });

  it('rejects a swapped-in foreign card (sig covers the card)', () => {
    const alice = Identity.random();
    const bob = Identity.random();
    const req = FriendNotice.sign(alice, 'request', bob.peerId);
    const forgedCard = {...req, card: FriendNotice.sign(bob, 'request', alice.peerId).card};
    expect(() => FriendNotice.verify(forgedCard)).toThrow();
  });

  it('derives the per-peer topic', () => {
    expect(friendRequestTopic('12D3KooWABC')).toBe('peers/v1/fr/12D3KooWABC');
  });
});
