import { describe, it, expect } from 'vitest';
import { AsyncLock } from '../../src/services/asyncLock.js';

describe('AsyncLock', () => {
  it('runs a task and returns its result', async () => {
    const lock = new AsyncLock();
    const result = await lock.run(() => 42);
    expect(result).toBe(42);
  });

  it('runs tasks sequentially', async () => {
    const lock = new AsyncLock();
    const order = [];

    const task1 = lock.run(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
      return 'done1';
    });

    const task2 = lock.run(async () => {
      order.push(3);
      await new Promise((r) => setTimeout(r, 20));
      order.push(4);
      return 'done2';
    });

    const [r1, r2] = await Promise.all([task1, task2]);
    expect(r1).toBe('done1');
    expect(r2).toBe('done2');
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('propagates errors without blocking subsequent tasks', async () => {
    const lock = new AsyncLock();

    const failing = lock.run(() => {
      throw new Error('fail');
    });

    await expect(failing).rejects.toThrow('fail');

    const success = lock.run(() => 'ok');
    await expect(success).resolves.toBe('ok');
  });

  it('handles rejected promises', async () => {
    const lock = new AsyncLock();

    const failing = lock.run(async () => {
      throw new Error('async error');
    });

    await expect(failing).rejects.toThrow('async error');

    const next = lock.run(() => 'recovered');
    await expect(next).resolves.toBe('recovered');
  });

  it('maintains order under high concurrency', async () => {
    const lock = new AsyncLock();
    const results = [];
    const tasks = [];

    for (let i = 0; i < 20; i++) {
      tasks.push(
        lock.run(async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          results.push(i);
          return i;
        })
      );
    }

    await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
});
