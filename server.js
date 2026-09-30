const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:devpass123@localhost:5432/shoestock';

const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

function nowIso() { return new Date().toISOString(); }

/* ---------- meta ---------- */
app.get('/api/meta', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM meta WHERE id=1');
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'อ่านข้อมูลกลางไม่สำเร็จ' }); }
});

app.put('/api/meta', async (req, res) => {
  const { products, custColors, skuCodes, skuNames, siteUrl, trashRetentionDays, newLogs, updatedBy } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT rev FROM meta WHERE id=1 FOR UPDATE');
    const nextRev = (cur.rows[0]?.rev || 0) + 1;
    const upd = await client.query(
      `UPDATE meta SET products=$1, cust_colors=$2, sku_codes=$3, sku_names=$4, site_url=$5,
       trash_retention_days=COALESCE($6::int, trash_retention_days), rev=$7, updated_by=$8, updated_at=now()
       WHERE id=1 RETURNING *`,
      [JSON.stringify(products || []), JSON.stringify(custColors || []), JSON.stringify(skuCodes || {}),
       JSON.stringify(skuNames || {}), siteUrl || '', (trashRetentionDays === undefined || trashRetentionDays === null) ? null : trashRetentionDays, nextRev, updatedBy || null]
    );
    if (Array.isArray(newLogs) && newLogs.length) {
      for (const l of newLogs) {
        await client.query('INSERT INTO logs (t, who, branch, action, detail) VALUES ($1,$2,$3,$4,$5)',
          [l.t || nowIso(), l.who || '', l.branch || '', l.action || '', l.detail || '']);
      }
    }
    await client.query('COMMIT');
    io.emit('meta:update', upd.rows[0]);
    res.json(upd.rows[0]);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'บันทึกข้อมูลกลางไม่สำเร็จ' }); }
  finally { client.release(); }
});

/* ---------- logs ---------- */
app.get('/api/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const r = await pool.query('SELECT t, who, branch, action, detail FROM logs ORDER BY t DESC LIMIT $1', [limit]);
    res.json(r.rows.reverse());
  } catch (e) { console.error(e); res.status(500).json({ error: 'อ่านประวัติไม่สำเร็จ' }); }
});

/* ---------- branches ---------- */
app.get('/api/branches/index', async (req, res) => {
  try {
    const r = await pool.query('SELECT bid, name FROM branches ORDER BY created_at ASC');
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'อ่านรายชื่อสาขาไม่สำเร็จ' }); }
});

app.get('/api/branches', async (req, res) => {
  try {
    const r = await pool.query('SELECT bid, name, payload, rev, updated_at FROM branches ORDER BY created_at ASC');
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'อ่านรายชื่อสาขาไม่สำเร็จ' }); }
});

app.get('/api/branches/:bid', async (req, res) => {
  try {
    const r = await pool.query('SELECT bid, name, payload, rev, updated_at FROM branches WHERE bid=$1', [req.params.bid]);
    if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบสาขานี้' });
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'อ่านสาขาไม่สำเร็จ' }); }
});

// สร้าง/บันทึกสาขา (คนละแถว คนละ row-lock — สาขาอื่นไม่ถูกกระทบเด็ดขาด)
// รองรับ optimistic concurrency ผ่าน expectedRev: ถ้าไคลเอนต์ส่ง expectedRev มาและไม่ตรงกับ rev
// ปัจจุบันในฐานข้อมูล (แปลว่ามีคนอื่นแก้ไปแล้วระหว่างที่เราถืออันเก่าอยู่) จะปฏิเสธด้วย 409 พร้อมข้อมูลล่าสุด
// แทนที่จะเขียนทับเงียบๆ ให้ของเก่ากว่าไปทับของใหม่กว่าโดยไม่รู้ตัว
app.put('/api/branches/:bid', async (req, res) => {
  const { bid } = req.params;
  const { name, payload, updatedBy, expectedRev } = req.body || {};
  if (!name || !payload) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT rev, payload FROM branches WHERE bid=$1 FOR UPDATE', [bid]);
    if (cur.rows.length && expectedRev != null && cur.rows[0].rev !== expectedRev) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'ข้อมูลสาขานี้ถูกแก้ไขจากเครื่องอื่นไปแล้วระหว่างที่คุณกำลังแก้ กรุณาลองใหม่',
        current: { bid, name: cur.rows[0].name, payload: cur.rows[0].payload, rev: cur.rows[0].rev }
      });
    }
    // ตาข่ายนิรภัยชั้นสอง (กันเหตุการณ์ "รอบนับที่ยืนยันแล้วหายไป"): ถ้าเครื่องที่ยิง PUT นี้เข้ามา
    // ถืองสำเนา JS เก่า (เช่นแคชหน้าเว็บค้างจากก่อนอัปเดต) จะไม่ส่ง expectedRev มาเลย ทำให้ผ่านเช็คด้านบนไปได้
    // แม้ payload ทั้งก้อนที่ส่งมาจะเก่ากว่าของในฐานข้อมูลก็ตาม — จุดนี้จึงตรวจซ้ำเฉพาะส่วน "รอบนับ" อีกชั้น:
    // ถ้าฐานข้อมูลปัจจุบันมีรอบนับใดที่ "ยืนยันแล้ว" (confirmed:true) อยู่ก่อน จะไม่มีทางถูกเขียนทับให้กลับไป
    // เป็นยังไม่ยืนยัน/หายไปได้เด็ดขาด เว้นแต่ของที่ส่งมาใหม่จะยืนยันเช่นกันและมีเวลายืนยัน (t) ใหม่กว่าจริง
    // (กรณีนับใหม่ทับของเดิมโดยตั้งใจ) — วิธีนี้ปกป้องข้อมูลรอบนับได้แม้ไคลเอนต์บางเครื่องยังไม่ได้อัปเดตโค้ด
    if (cur.rows.length && cur.rows[0].payload && cur.rows[0].payload.rounds) {
      const dbRounds = cur.rows[0].payload.rounds;
      payload.rounds = payload.rounds || {};
      for (const d of Object.keys(dbRounds)) {
        const dbDay = dbRounds[d] || {};
        for (const r of Object.keys(dbDay)) {
          const dbSess = dbDay[r];
          if (dbSess && dbSess.confirmed) {
            const incomingDay = payload.rounds[d] || {};
            const incoming = incomingDay[r];
            const incomingNewer = !!(incoming && incoming.confirmed && incoming.t && dbSess.t && new Date(incoming.t) > new Date(dbSess.t));
            if (!incomingNewer) {
              payload.rounds[d] = payload.rounds[d] || {};
              payload.rounds[d][r] = dbSess;
            }
          }
        }
      }
    }
    const nextRev = (cur.rows[0]?.rev || 0) + 1;
    const upd = await client.query(
      `INSERT INTO branches (bid, name, payload, rev, updated_by, updated_at, created_at)
       VALUES ($1,$2,$3,1,$4,now(),now())
       ON CONFLICT (bid) DO UPDATE SET name=$2, payload=$3, rev=$5, updated_by=$4, updated_at=now()
       RETURNING bid, name, payload, rev, updated_at`,
      [bid, name, JSON.stringify(payload), updatedBy || null, nextRev]
    );
    await client.query('COMMIT');
    const row = upd.rows[0];
    io.to('branch:' + bid).emit('branch:update', { ...row, updatedBy: updatedBy || null });
    io.to('admin').emit('branches:changed', { type: 'upsert', bid, name: row.name });
    res.json(row);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'บันทึกสาขาไม่สำเร็จ' }); }
  finally { client.release(); }
});

// อัปเดตเฉพาะ "รอบนับสต๊อก" ของวัน/รอบเดียว แบบ path-level merge ภายใต้ row lock
// จุดสำคัญ: endpoint นี้จะไม่แตะ arrange/catalog/shelfNames/ฯลฯ ของ payload เลย ต่อให้ต้นทางที่ส่งมา
// (ฝั่งพนักงานนับสต๊อก) จะถือสำเนา payload เก่ากว่าฝั่งอื่นอยู่ก็ตาม — จึงไม่มีทางที่การยืนยันรอบนับ
// จะไปเขียนทับการแก้ผัง/แคตตาล็อกที่ฝั่งแอดมินเพิ่งบันทึกพร้อมกัน และในทางกลับกัน การแก้ผังฝั่งแอดมิน
// ก็ไม่มีทางไปเขียนทับรอบนับที่เพิ่งยืนยันเช่นกัน เพราะทั้งสองฝั่งแก้กันคนละ path ใน payload เดียวกัน
app.put('/api/branches/:bid/round', async (req, res) => {
  const { bid } = req.params;
  const { date, round, session, updatedBy } = req.body || {};
  if (!date || !round || !session) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT payload, rev FROM branches WHERE bid=$1 FOR UPDATE', [bid]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสาขานี้' }); }
    const payload = cur.rows[0].payload || {};
    payload.rounds = payload.rounds || {};
    payload.rounds[date] = payload.rounds[date] || {};
    payload.rounds[date][round] = session; // ทับเฉพาะรอบนับของวัน/รอบนี้เท่านั้น ส่วนอื่นของ payload คงเดิมตามที่อยู่ในฐานข้อมูลล่าสุด
    const nextRev = (cur.rows[0].rev || 0) + 1;
    const upd = await client.query(
      `UPDATE branches SET payload=$1, rev=$2, updated_by=$3, updated_at=now() WHERE bid=$4
       RETURNING bid, name, payload, rev, updated_at`,
      [JSON.stringify(payload), nextRev, updatedBy || null, bid]
    );
    await client.query('COMMIT');
    const row = upd.rows[0];
    io.to('branch:' + bid).emit('branch:update', { ...row, updatedBy: updatedBy || null });
    io.to('admin').emit('branches:changed', { type: 'upsert', bid, name: row.name });
    res.json(row);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'บันทึกรอบนับไม่สำเร็จ' }); }
  finally { client.release(); }
});

// ลบสาขา → ย้ายเข้าถังขยะ (ไม่ลบจริง)
app.delete('/api/branches/:bid', async (req, res) => {
  const { bid } = req.params;
  const deletedBy = req.query.by || req.body?.updatedBy || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const br = await client.query('SELECT * FROM branches WHERE bid=$1 FOR UPDATE', [bid]);
    if (!br.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสาขานี้' }); }
    const b = br.rows[0];
    const metaR = await client.query('SELECT trash_retention_days FROM meta WHERE id=1');
    const days = (metaR.rows[0]?.trash_retention_days ?? 7);
    await client.query(
      `INSERT INTO branches_trash (bid, name, payload, rev, deleted_by, deleted_at, purge_at)
       VALUES ($1,$2,$3,$4,$5, now(), now() + ($6 || ' days')::interval)`,
      [b.bid, b.name, b.payload, b.rev, deletedBy, String(days)]
    );
    await client.query('DELETE FROM branches WHERE bid=$1', [bid]);
    await client.query('COMMIT');
    io.to('admin').emit('branches:changed', { type: 'delete', bid, name: b.name });
    res.json({ ok: true, purgeInDays: days });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'ลบสาขาไม่สำเร็จ' }); }
  finally { client.release(); }
});

/* ---------- ถังขยะ ---------- */
app.get('/api/trash', async (req, res) => {
  try {
    const r = await pool.query('SELECT bid, name, deleted_by, deleted_at, purge_at FROM branches_trash ORDER BY deleted_at DESC');
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'อ่านถังขยะไม่สำเร็จ' }); }
});

app.post('/api/trash/:bid/restore', async (req, res) => {
  const { bid } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tr = await client.query('SELECT * FROM branches_trash WHERE bid=$1 FOR UPDATE', [bid]);
    if (!tr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบในถังขยะ' }); }
    const t = tr.rows[0];
    const exists = await client.query('SELECT 1 FROM branches WHERE bid=$1', [bid]);
    if (exists.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'มีสาขา bid นี้อยู่แล้วในระบบ กู้คืนไม่ได้ (ชนกัน)' }); }
    await client.query(
      `INSERT INTO branches (bid, name, payload, rev, updated_by, updated_at, created_at)
       VALUES ($1,$2,$3,$4,$5, now(), now())`,
      [t.bid, t.name, t.payload, t.rev, t.deleted_by]
    );
    await client.query('DELETE FROM branches_trash WHERE bid=$1', [bid]);
    await client.query('COMMIT');
    io.to('admin').emit('branches:changed', { type: 'restore', bid, name: t.name });
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'กู้คืนไม่สำเร็จ' }); }
  finally { client.release(); }
});

// ลบทิ้งถาวรทันที (มือกด ไม่ต้องรอครบกำหนด)
app.delete('/api/trash/:bid', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM branches_trash WHERE bid=$1 RETURNING bid', [req.params.bid]);
    if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบในถังขยะ' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'ลบถาวรไม่สำเร็จ' }); }
});

/* ---------- งานลบถังขยะอัตโนมัติเมื่อครบกำหนด ---------- */
async function purgeExpiredTrash() {
  try {
    const r = await pool.query('DELETE FROM branches_trash WHERE purge_at <= now() RETURNING bid, name');
    if (r.rows.length) console.log('purged expired trash:', r.rows.map(x => x.name).join(', '));
  } catch (e) { console.error('purge job failed', e); }
}
const PURGE_INTERVAL_MS = parseInt(process.env.PURGE_INTERVAL_MS, 10) || 60 * 60 * 1000; // ทุก 1 ชั่วโมง (ปรับได้ผ่าน env ตอนทดสอบ)
setInterval(purgeExpiredTrash, PURGE_INTERVAL_MS);

/* ---------- Socket.io: ห้องแยกตามสาขา ---------- */
io.on('connection', (socket) => {
  socket.on('join', ({ bid, admin }) => {
    if (admin) socket.join('admin');
    if (bid) socket.join('branch:' + bid);
  });
  socket.on('leave', ({ bid, admin }) => {
    if (admin) socket.leave('admin');
    if (bid) socket.leave('branch:' + bid);
  });
});

async function ensureSchema() {
  try {
    const fs = require('fs');
    const sql = fs.readFileSync(require('path').join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Schema ready.');
  } catch (e) { console.error('ensureSchema failed', e); }
}

if (require.main === module) {
  ensureSchema().then(() => {
    server.listen(PORT, () => console.log('Backend listening on port ' + PORT));
  });
}

module.exports = { app, server, pool, purgeExpiredTrash };
