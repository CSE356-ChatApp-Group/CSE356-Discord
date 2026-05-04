const {
  redisBatchMget,
  redisBatchHmget,
  redisBatchSmismember,
} = require('../src/db/redisBatch');

function makeClient(execResultFactory) {
  return {
    pipeline: () => {
      const calls = [];
      const p = {
        get: (key) => {
          calls.push({ cmd: 'get', key });
          return p;
        },
        hmget: (key, ...fields) => {
          calls.push({ cmd: 'hmget', key, fields });
          return p;
        },
        smismember: (key, ...members) => {
          calls.push({ cmd: 'smismember', key, members });
          return p;
        },
        call: (_cmd, key, ...members) => {
          calls.push({ cmd: 'smismember', key, members });
          return p;
        },
        exec: async () => execResultFactory(calls),
      };
      return p;
    },
  };
}

describe('redisBatch', () => {
  it('redisBatchMget preserves key order across chunks', async () => {
    // redisBatchMget now issues one GET per key (not chunked MGET) so cross-slot
    // keys work in cluster mode. Each call has shape { cmd: 'get', key }.
    const client = makeClient((calls) =>
      calls.map((call) => [null, `v:${call.key}`]),
    );
    const out = await redisBatchMget(client, ['a', 'b', 'c'], 2);
    expect(out).toEqual(['v:a', 'v:b', 'v:c']);
  });

  it('redisBatchMget throws when a key command fails', async () => {
    const err = new Error('redis chunk failed');
    const client = makeClient((_calls) => [[null, 'v:a'], [err, null]]);
    await expect(redisBatchMget(client, ['a', 'b'], 1)).rejects.toThrow('redis chunk failed');
  });

  it('redisBatchHmget normalizes invalid chunk sizes', async () => {
    const client = makeClient((calls) =>
      calls.map((call) => [null, call.fields.map((f) => `h:${f}`)]),
    );
    const out = await redisBatchHmget(client, 'hash:key', ['f1', 'f2'], 0);
    expect(out).toEqual(['h:f1', 'h:f2']);
  });

  it('redisBatchSmismember returns normalized 0/1 values', async () => {
    const client = makeClient((_calls) => [[null, [1, 0, '1', '0']]]);
    const out = await redisBatchSmismember(client, 'set:key', ['a', 'b', 'c', 'd'], 10);
    expect(out).toEqual([1, 0, 1, 0]);
  });
});
