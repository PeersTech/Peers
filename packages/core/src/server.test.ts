import {describe, expect, it} from 'vitest';
import {
  channelTopic,
  Invite,
  newServerId,
  PlazaMessage,
  Role,
  serverTopic,
  ServerDir,
  ServerKeys,
  ServerRecord,
  SignedMessage,
  Snapshot,
} from './server.js';
import type {Member} from './server.js';
import {Identity, PeerCard, SignedProfile} from './index.js';

function ownedRecord(name: string, ownerPeer = 'alice'): ServerRecord {
  const identity = Identity.random();
  return ServerRecord.newOwned(newServerId(), name, ownerPeer, PeerCard.sign(identity));
}

function bobMember(): Member {
  return {peerId: 'bob', name: 'bob', role: 'member' as Role, joinedEpoch: 1};
}

describe('invites', () => {
  it('verify against their own embedded key', () => {
    expect(Invite.verify(ownedRecord('test').invite())).toBe(true);
  });

  it('tampered invite fails', () => {
    const invite = ownedRecord('test').invite();
    const tampered: Invite = structuredClone(invite);
    tampered.payload.nextPub[0]! ^= 0xff;
    expect(Invite.verify(tampered)).toBe(false);
  });
});

describe('signed lists (rotation chain)', () => {
  it('verifies and advances the chain', () => {
    const owner = ownedRecord('chain');
    const list = owner.signedList();
    const joiner = ServerRecord.newJoined(owner.invite());
    joiner.verifyList(list);
    expect(joiner.members).toHaveLength(1);
    expect(joiner.knownPub).toEqual(list.payload.nextPub);
  });

  it('rotated list links epochs', () => {
    const owner = ownedRecord('rotate');
    owner.keys!.rotate();
    const list = owner.signedList();
    const joiner = ServerRecord.newJoined(owner.invite());
    joiner.verifyList(list);
    expect(joiner.knownPub).toEqual(list.payload.nextPub);
  });

  it('stale key rejected (UnknownEpoch)', () => {
    const owner = ownedRecord('stale');
    const list0 = owner.signedList();
    const joiner = ServerRecord.newJoined(owner.invite());
    joiner.verifyList(list0);
    owner.keys!.rotate();
    joiner.verifyList(owner.signedList());
    expect(() => joiner.verifyList(list0)).toThrow(/epoch/i);
  });

  it('non-owner cannot sign a list', () => {
    const joiner = ServerRecord.newJoined(ownedRecord('nope').invite());
    expect(() => joiner.signedList()).toThrow(/owner/i);
  });
});

describe('roles and ACLs', () => {
  it('member < admin < owner', () => {
    expect(Role.rank('member')).toBeLessThan(Role.rank('admin'));
    expect(Role.rank('admin')).toBeLessThan(Role.rank('owner'));
  });

  it('channel ACLs gate writes', () => {
    const owner = ownedRecord('acl');
    owner.members.push(bobMember());
    owner.channels.push({name: 'admin-only', topic: 'admin-only', readMin: 'admin', writeMin: 'admin'});
    expect(owner.canWrite('bob', 'general')).toBe(true);
    expect(owner.canWrite('bob', 'admin-only')).toBe(false);
    expect(owner.canWrite('alice', 'admin-only')).toBe(true);
    expect(owner.canWrite('stranger', 'general')).toBe(false);
  });
});

describe('signed messages', () => {
  it('round trips and verifies membership + authorship', () => {
    const owner = ownedRecord('msgs');
    const sender = Identity.random();
    owner.members.push({peerId: sender.peerId, name: 'singer', role: 'member', joinedEpoch: 1});
    const msg = SignedMessage.sign(sender, owner.id, 'general', 'hello');
    SignedMessage.verify(msg, owner);
    const tampered = {...msg, text: 'hacked'};
    expect(() => SignedMessage.verify(tampered, owner)).toThrow(/corrupt/i);
    const stranger = ownedRecord('stranger');
    expect(() => SignedMessage.verify(msg, stranger)).toThrow(/member/i);
  });
});

describe('persistence round trip', () => {
  it('restored owner can still sign lists and invites', () => {
    const owner = ownedRecord('persist');
    owner.keys!.rotate();
    owner.channels.push({name: 'off-topic', topic: 'off-topic', readMin: 'member', writeMin: 'member'});
    const restored = ServerRecord.fromPersisted(owner.toPersisted());
    expect(restored.id).toBe(owner.id);
    expect(restored.name).toBe(owner.name);
    expect(restored.ownerPeer).toBe(owner.ownerPeer);
    expect(restored.knownPub).toEqual(owner.knownPub);
    expect(restored.members).toEqual(owner.members);
    expect(restored.channels).toEqual(owner.channels);
    expect(restored.keys!.epoch).toBe(1);

    const list = restored.signedList();
    const joiner = ServerRecord.newJoined(restored.invite());
    joiner.verifyList(list);
    expect(joiner.knownPub).toEqual(list.payload.nextPub);
  });
});

describe('snapshots', () => {
  it('sign, verify, reject tampering; members verify too', () => {
    const owner = ownedRecord('snap');
    const sender = Identity.random();
    owner.members.push({peerId: sender.peerId, name: 'm', role: 'member', joinedEpoch: 1});
    const msg = SignedMessage.sign(sender, owner.id, 'general', 'snapshot this');
    const snap = Snapshot.sign(owner, [msg]);
    Snapshot.verify(snap, owner);

    const tampered = {...snap, messages: [{...msg, text: 'rewritten'}]};
    expect(() => Snapshot.verify(tampered, owner)).toThrow();

    // A member who followed the chain can verify an owner-made snapshot.
    const member = ServerRecord.newJoined(owner.invite());
    member.verifyList(owner.signedList());
    Snapshot.verify(snap, member);
  });
});

describe('server dir', () => {
  it('create, view, duplicate-join rejected', () => {
    const dir = new ServerDir();
    const rec = dir.create(newServerId(), 'testers', 'me', PeerCard.sign(Identity.random()));
    expect(dir.get(rec.id)?.name).toBe('testers');

    const invite = rec.invite();
    expect(() => dir.join(invite)).toThrow(/already/i);

    const joined = dir.join(ownedRecord('other').invite());
    expect(joined.view('someone').pending).toBe(true);
  });

  it('views expose ownership and roles', () => {
    const dir = new ServerDir();
    const rec = dir.create(newServerId(), 'mine', 'alice-id', PeerCard.sign(Identity.random()));
    const view = rec.view('alice-id');
    expect(view.isOwner).toBe(true);
    expect(view.myRole).toBe('owner');
    expect(view.memberCount).toBe(1);
    expect(view.pending).toBe(false);
  });

  it('key rotation is independent per server', () => {
    const a = new ServerKeys();
    const b = new ServerKeys();
    a.rotate();
    expect(a.epoch).toBe(1);
    expect(b.epoch).toBe(0);
  });
});

describe('topics and ids', () => {
  it('formats server/channel topics', () => {
    expect(serverTopic('abc')).toBe('peers/v1/srv/abc');
    expect(channelTopic('abc', 'general')).toBe('peers/v1/ch/abc/general');
  });

  it('server ids are 16 hex chars', () => {
    expect(newServerId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('plaza', () => {
  it('chat messages sign and verify', () => {
    const id = Identity.random();
    const msg = PlazaMessage.sign(id, 'chat', 'gm');
    PlazaMessage.verify(msg);
    const tampered = {...msg, text: 'not gm'};
    expect(() => PlazaMessage.verify(tampered)).toThrow();
  });

  it('profile rides along and must match the sender', () => {
    const id = Identity.random();
    const profile = SignedProfile.sign(id, '', '', null);
    const msg = PlazaMessage.sign(id, 'profile', '', {profile});
    PlazaMessage.verify(msg);
    // A stranger cannot ride someone else's verified profile.
    const stranger = Identity.random();
    const stolen = PlazaMessage.sign(stranger, 'profile', '', {profile});
    expect(() => PlazaMessage.verify(stolen)).toThrow();
  });
});
