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
app.put('/api/branches/:bid', async (req, res) => {
  const { bid } = req.params;
  const { name, payload, updatedBy } = req.body || {};
  if (!name || !payload) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  try {
    const r = await pool.query(
      `INSERT INTO branches (bid, name, payload, rev, updated_by, updated_at, created_at)
       VALUES ($1,$2,$3,1,$4,now(),now())
       ON CONFLICT (bid) DO UPDATE SET name=$2, payload=$3, rev=branches.rev+1, updated_by=$4, updated_at=now()
       RETURNING bid, name, payload, rev, updated_at`,
      [bid, name, JSON.stringify(payload), updatedBy || null]
    );
    const row = r.rows[0];
    io.to('branch:' + bid).emit('branch:update', { ...row, updatedBy: updatedBy || null });
    io.to('admin').emit('branches:changed', { type: 'upsert', bid, name: row.name });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: 'บันทึกสาขาไม่สำเร็จ' }); }
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
