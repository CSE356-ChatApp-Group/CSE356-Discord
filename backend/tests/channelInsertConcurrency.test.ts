import { runChannelMessageInsertSerialized } from '../src/messages/channelInsertConcurrency';

describe('runChannelMessageInsertSerialized', () => {
  it('runs immediately when channelId is null', async () => {
    let ran = false;
    await runChannelMessageInsertSerialized(null, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('serializes same-channel jobs in order', async () => {
    const order: number[] = [];
    const ch = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    const p1 = runChannelMessageInsertSerialized(ch, async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 25));
      order.push(2);
    });
    const p2 = runChannelMessageInsertSerialized(ch, async () => {
      order.push(3);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not serialize different channels', async () => {
    const order: string[] = [];
    const chA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const chB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const pA = runChannelMessageInsertSerialized(chA, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('a-end');
    });
    const pB = runChannelMessageInsertSerialized(chB, async () => {
      order.push('b');
    });
    await Promise.all([pA, pB]);
    expect(order).toContain('b');
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a-end'));
  });

  it('continues chain after rejection', async () => {
    const ch = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const order: string[] = [];

    try {
      await runChannelMessageInsertSerialized(ch, async () => {
        order.push('a');
        throw new Error('fail');
      });
    } catch (e: any) {
      expect(e?.message).toBe('fail');
    }

    await runChannelMessageInsertSerialized(ch, async () => {
      order.push('b');
    });
    expect(order).toEqual(['a', 'b']);
  });
});
