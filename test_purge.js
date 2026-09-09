const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:devpass123@localhost:5432/shoestock' });
async function purgeExpiredTrash() {
  const r = await pool.query('DELETE FROM branches_trash WHERE purge_at <= now() RETURNING bid, name');
  console.log('purged:', r.rows.map(x => x.name));
}
purgeExpiredTrash().then(async () => {
  const r = await pool.query('SELECT bid FROM branches_trash');
  console.log('เหลือในถังขยะหลังรัน purge job:', JSON.stringify(r.rows));
  await pool.end();
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
