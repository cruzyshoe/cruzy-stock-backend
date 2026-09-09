# Deploy Backend บน Railway (Node + Express + Socket.io + PostgreSQL)

## ขั้นตอน

### 1) สร้าง PostgreSQL บน Railway
1. เข้า https://railway.app → New Project → **Provision PostgreSQL**
2. Railway จะสร้างฐานข้อมูลให้อัตโนมัติ พร้อมตัวแปร `DATABASE_URL` (ดูได้ในแท็บ Variables ของ service Postgres)

### 2) Deploy โค้ด backend นี้
1. Push โฟลเดอร์นี้ทั้งหมด (`server.js`, `schema.sql`, `package.json`, `Dockerfile`) ขึ้น GitHub repo ใหม่
2. ใน Railway project เดียวกัน กด **New → GitHub Repo** เลือก repo ที่เพิ่ง push
3. ไปที่ตั้งค่า service ที่เพิ่งสร้าง → **Variables** → เพิ่ม:
   - `DATABASE_URL` = อ้างอิงจาก Postgres service (Railway มีปุ่ม "Add Reference" ให้เลือกดึงมาจาก service Postgres ได้เลย ไม่ต้อง copy เอง)
   - `PGSSL` = `true` (Railway Postgres ต้องต่อผ่าน SSL)
4. Deploy — Railway จะ build จาก Dockerfile อัตโนมัติ
5. **ตาราง/schema จะถูกสร้างให้อัตโนมัติตอนสตาร์ทครั้งแรก** ไม่ต้องรัน SQL เองเลย (ดูจาก log ควรเห็น "Schema ready.")
6. หลัง deploy เสร็จ Railway จะให้ URL แบบ `xxx.up.railway.app` มา — **นี่คือ URL backend ที่ต้องเอาไปใส่ในไฟล์เว็บ** (ดูขั้นตอนถัดไป)

### 3) เชื่อมกับไฟล์เว็บ (frontend)
เปิดไฟล์ `index.html` (เว็บฝั่งผู้ใช้) หา:
```js
const DEFAULT_SYNC_URL='http://localhost:3001';
```
แก้เป็น URL ของ backend จริงที่ได้จาก Railway (ขั้นตอน 2.6):
```js
const DEFAULT_SYNC_URL='https://xxx.up.railway.app';
```
แล้ว deploy ไฟล์เว็บนี้แยกต่างหาก (เช่น Netlify/Vercel/Railway อีก service หนึ่งก็ได้) ตามที่เคยทำมาก่อนหน้านี้

## ทดสอบก่อน push (ถ้าต้องการ)
```bash
npm install
DATABASE_URL="postgres://user:pass@localhost:5432/dbname" node server.js
```

## หมายเหตุ
- ไม่ต้องตั้งค่า Environment Variable อื่นนอกจาก `DATABASE_URL` และ `PGSSL` (ค่า `PORT` Railway จะกำหนดให้เองอัตโนมัติ)
- งานลบถังขยะอัตโนมัติทำงานทุก 1 ชั่วโมง (ปรับได้ผ่าน env `PURGE_INTERVAL_MS` หน่วยเป็นมิลลิวินาที)
