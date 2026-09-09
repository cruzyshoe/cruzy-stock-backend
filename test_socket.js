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
  const clientA = io('http://localhost:3001'); // เครื่องที่ join room สาขา bE
  const clientAdmin = io('http://localhost:3001'); // เครื่องหลังบ้าน join room admin

  let receivedBranchUpdate = null;
  let receivedBranchesChanged = null;

  await new Promise(r => clientA.on('connect', r));
  await new Promise(r => clientAdmin.on('connect', r));

  clientA.emit('join', { bid: 'bE' });
  clientAdmin.emit('join', { admin: true });

  clientA.on('branch:update', (data) => { receivedBranchUpdate = data; });
  clientAdmin.on('branches:changed', (data) => { receivedBranchesChanged = data; });

  await new Promise(r => setTimeout(r, 300)); // รอ join สำเร็จ

  // "เครื่องอื่น" แก้สาขา bE ผ่าน REST API
  await put('bE', { name: 'branch-E', payload: { bid: 'bE', name: 'branch-E', arrange: [[[[{ hi: 1 }]]]] }, updatedBy: 'otherDevice' });

  await new Promise(r => setTimeout(r, 500)); // รอ socket event มาถึง

  console.log('clientA (join bE) ได้รับ branch:update ไหม:', !!receivedBranchUpdate);
  console.log('  ข้อมูลที่ได้รับ:', JSON.stringify(receivedBranchUpdate?.payload?.arrange));
  console.log('clientAdmin (join admin) ได้รับ branches:changed ไหม:', !!receivedBranchesChanged);
  console.log('  รายละเอียด:', JSON.stringify(receivedBranchesChanged));

  const pass = !!receivedBranchUpdate && receivedBranchUpdate.payload.arrange[0][0][0][0].hi === 1 && !!receivedBranchesChanged;
  console.log('\nสรุป PASS:', pass);

  clientA.close(); clientAdmin.close();
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
