const { io } = require('socket.io-client');
const http = require('http');
function put(bid, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/branches/' + bid, method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function main() {
  const clientF = io('http://localhost:3001'); // join สาขา bF
  const clientG = io('http://localhost:3001'); // join สาขา bG (คนละสาขา)
  await new Promise(r => clientF.on('connect', r));
  await new Promise(r => clientG.on('connect', r));
  clientF.emit('join', { bid: 'bF' });
  clientG.emit('join', { bid: 'bG' });
  let gReceived = false;
  clientG.on('branch:update', () => { gReceived = true; });
  await new Promise(r => setTimeout(r, 300));

  await put('bF', { name: 'branch-F', payload: { bid: 'bF', name: 'branch-F' }, updatedBy: 'x' });
  await new Promise(r => setTimeout(r, 500));

  console.log('clientG (join bG) ได้รับ update ของ bF ไหม (ต้องไม่ได้รับ):', gReceived);
  const pass = !gReceived;
  console.log('สรุป PASS (แยกห้องกันจริง):', pass);
  clientF.close(); clientG.close();
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
