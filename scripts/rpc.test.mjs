import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { rpcLookup } from './rpc.mjs';

const KEY = 'AAAABw==';
const FAST = { delayMs: 0 };

/** A local RPC that answers request n with script[n] (the last step repeats), and counts requests. */
async function serve(script) {
  const seen = { requests: 0, bodies: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.bodies.push(body);
      const step = script[Math.min(seen.requests, script.length - 1)];
      seen.requests += 1;
      step(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const json = (value) => (res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};
const text = (body, code = 200) => (res) => {
  res.statusCode = code;
  res.end(body);
};

test('sends one getLedgerEntries request with the key it was given', async () => {
  const rpc = await serve([json({ jsonrpc: '2.0', id: 1, result: { entries: [], latestLedger: 3 } })]);
  try {
    assert.deepEqual(await rpcLookup(rpc.url, KEY, FAST), { entries: [], latestLedger: 3 });
    assert.deepEqual(JSON.parse(rpc.seen.bodies[0]), { jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [KEY] } });
  } finally {
    await rpc.close();
  }
});

test('a 200 that is not JSON is retried once, then reported as not JSON', async () => {
  const rpc = await serve([text('<html>bad gateway</html>')]);
  try {
    await assert.rejects(rpcLookup(rpc.url, KEY, FAST), /not JSON/);
    assert.equal(rpc.seen.requests, 2);
  } finally {
    await rpc.close();
  }
});

test('a non-JSON page that is followed by a good answer is recovered from', async () => {
  const rpc = await serve([text('<html>'), json({ jsonrpc: '2.0', id: 1, result: { entries: [], latestLedger: 9 } })]);
  try {
    assert.equal((await rpcLookup(rpc.url, KEY, FAST)).latestLedger, 9);
  } finally {
    await rpc.close();
  }
});

test('an answer with neither a result nor an error is refused, not read as "no such entry"', async () => {
  for (const reply of [{}, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, result: null }, []]) {
    const rpc = await serve([json(reply)]);
    try {
      await assert.rejects(rpcLookup(rpc.url, KEY, FAST), /without a result/, JSON.stringify(reply));
      assert.equal(rpc.seen.requests, 1, 'asking again cannot fix it');
    } finally {
      await rpc.close();
    }
  }
});

test('a JSON-RPC error is reported with its message and not retried', async () => {
  const rpc = await serve([json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad key' } })]);
  try {
    await assert.rejects(rpcLookup(rpc.url, KEY, FAST), /the RPC returned an error: bad key/);
    assert.equal(rpc.seen.requests, 1);
  } finally {
    await rpc.close();
  }
});

test('an error without a message is still shown', async () => {
  const rpc = await serve([json({ jsonrpc: '2.0', id: 1, error: { code: 5 } })]);
  try {
    await assert.rejects(rpcLookup(rpc.url, KEY, FAST), /the RPC returned an error: \{"code":5\}/);
  } finally {
    await rpc.close();
  }
});
