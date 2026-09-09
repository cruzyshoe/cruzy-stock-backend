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
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: 3001, path }, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}
async function main() {
  // 2 "เครื่อง" แก้คนละสาขาพร้อมกันจริงๆ ด้วย Promise.all (จำลองปัญหาที่เจอกับ Firebase)
  const results = await Promise.all([
    put('bA', { name: 'branch-A', payload: { bid: 'bA', name: 'branch-A', arrange: [[[[{ m: 'X', s: '1', c: 'white', t: 'SHOW' }, { m: 'X', s: '1', c: 'white', t: 'STOCK' }]]]] }, updatedBy: 'dev1' }),
    put('bB', { name: 'branch-B', payload: { bid: 'bB', name: 'branch-B', arrange: [[[[{ m: 'Y', s: '2', c: 'gray', t: 'SHOW' }]]]] }, updatedBy: 'dev2' }),
  ]);
  console.log('push A rev:', results[0].rev, '| push B rev:', results[1].rev);

  // ยิงแก้สาขาเดียวกัน (bA) พร้อมกัน 10 ครั้งรัว ๆ เพื่อทดสอบว่า rev เพิ่มถูกต้องไม่ชนกันเอง (race condition)
  const race = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    put('bA', { name: 'branch-A', payload: { bid: 'bA', name: 'branch-A', arrange: [[[[{ hit: i }]]]] }, updatedBy: 'racer' + i })
  ));
  const revs = race.map(r => r.rev).sort((a, b) => a - b);
  const isSequential = revs.every((v, i) => i === 0 || v === revs[i - 1] + 1);
  console.log('revs หลังยิง 10 ครั้งพร้อมกัน:', revs, '| ต่อเนื่องไม่ชนกัน:', isSequential);

  const finalA = await get('/api/branches/bA');
  const finalB = await get('/api/branches/bB');
  console.log('bA สุดท้าย rev =', finalA.rev, '| bB ไม่ถูกกระทบเลย rev =', finalB.rev, 'arrange:', JSON.stringify(finalB.payload.arrange));

  const pass = isSequential && finalA.rev === 11 && finalB.payload.arrange[0][0][0][0].m === 'Y';
  console.log('\nสรุป PASS:', pass);
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
