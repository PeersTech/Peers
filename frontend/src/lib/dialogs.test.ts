import {describe, expect, it, vi} from 'vitest';
import {
    DialogController,
    validateChannelName,
    validateJson,
    validatePeerId,
    validateRequired,
} from './dialogs';

describe('DialogController', () => {
    it('resolves confirmations and cancellations', async () => {
        const controller = new DialogController();
        const accepted = controller.confirm({title: 'Accept?'});
        controller.resolveCurrent(true);
        await expect(accepted).resolves.toBe(true);

        const cancelled = controller.confirm({title: 'Cancel?'});
        controller.cancelCurrent();
        await expect(cancelled).resolves.toBe(false);
    });

    it('returns prompt values and null on cancellation', async () => {
        const controller = new DialogController();
        const entered = controller.prompt({title: 'Name'});
        controller.resolveCurrent('Peers');
        await expect(entered).resolves.toBe('Peers');

        const cancelled = controller.prompt({title: 'Name'});
        controller.cancelCurrent();
        await expect(cancelled).resolves.toBeNull();
    });

    it('queues requests in FIFO order instead of dropping them', async () => {
        const controller = new DialogController();
        const changed = vi.fn();
        controller.subscribe(changed);
        const first = controller.prompt({title: 'First'});
        const second = controller.confirm({title: 'Second'});

        expect(controller.getCurrent()?.title).toBe('First');
        controller.resolveCurrent('one');
        expect(controller.getCurrent()?.title).toBe('Second');
        controller.resolveCurrent(true);

        await expect(first).resolves.toBe('one');
        await expect(second).resolves.toBe(true);
        expect(changed).toHaveBeenCalled();
    });

    it('settles every pending request when destroyed', async () => {
        const controller = new DialogController();
        const prompt = controller.prompt({title: 'Prompt'});
        const confirm = controller.confirm({title: 'Confirm'});
        controller.destroy();
        await expect(prompt).resolves.toBeNull();
        await expect(confirm).resolves.toBe(false);
    });
});

describe('dialog validators', () => {
    it('validates required and bounded names', () => {
        expect(validateRequired('Server')('  ')).toMatch(/required/);
        expect(validateRequired('Server', 3)('four')).toMatch(/3/);
        expect(validateRequired('Server')('Peers')).toBeNull();
    });

    it('validates peer ids without pretending to cryptographically parse them', () => {
        expect(validatePeerId('short')).toMatch(/full/);
        expect(validatePeerId('0'.repeat(45))).toMatch(/invalid/);
        expect(validatePeerId('1'.repeat(45))).toBeNull();
    });

    it('validates JSON objects and channel slugs', () => {
        expect(validateJson('Invite')('{oops')).toMatch(/valid JSON/);
        expect(validateJson('Invite')('[]')).toMatch(/object/);
        expect(validateJson('Invite')('{"ok":true}')).toBeNull();
        expect(validateChannelName('General Chat')).toMatch(/lowercase/);
        expect(validateChannelName('general-chat')).toBeNull();
    });
});
