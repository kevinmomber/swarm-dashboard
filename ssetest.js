(async () => {
  const nodes = await (await fetch('http://localhost:3000/api/nodes')).json();
  const nid = (nodes.find((n) => n.connected) || nodes[0]).id;
  const res = await fetch('http://localhost:3000/api/volumes/duplicate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ srcNodeId: nid, name: 'sd-big-src', dstNodeId: nid, newName: 'sd-big-copy' }),
  });
  console.log('status', res.status, 'ctype', res.headers.get('content-type'));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', size = null, progressCount = 0, lastBytes = 0, done = false, error = null;
  for (;;) {
    const { value, done: d } = await reader.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const e = JSON.parse(line.slice(5).trim());
      if (e.type === 'size') size = e.total;
      else if (e.type === 'progress') { progressCount++; lastBytes = e.bytes; }
      else if (e.type === 'done') done = true;
      else if (e.type === 'error') error = e.message;
    }
  }
  console.log('size(total)=', size, 'progressEvents=', progressCount, 'lastBytes=', lastBytes, 'done=', done, 'error=', error);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
