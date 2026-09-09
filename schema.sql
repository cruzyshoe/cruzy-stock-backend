-- ตารางข้อมูลกลาง (สินค้า/สี/รหัส SKU/ตั้งค่าถังขยะ) มีแถวเดียวเสมอ (id=1)
CREATE TABLE IF NOT EXISTS meta (
  id INT PRIMARY KEY DEFAULT 1,
  products JSONB NOT NULL DEFAULT '[]',
  cust_colors JSONB NOT NULL DEFAULT '[]',
  sku_codes JSONB NOT NULL DEFAULT '{}',
  sku_names JSONB NOT NULL DEFAULT '{}',
  site_url TEXT NOT NULL DEFAULT '',
  trash_retention_days INT NOT NULL DEFAULT 7,
  rev INT NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ตารางสาขา (คนละแถว = คนละสาขา, คนละ row lock กันชนกัน)
CREATE TABLE IF NOT EXISTS branches (
  bid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload JSONB NOT NULL,       -- เก็บ shelfNames/arrange/actual/rounds/ฯลฯ ทั้งก้อนแบบเดียวกับ Firebase เดิม
  rev INT NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ถังขยะ: ย้ายสาขาที่ถูกลบมาไว้ที่นี่ก่อน ไม่ลบจริงทันที
CREATE TABLE IF NOT EXISTS branches_trash (
  bid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload JSONB NOT NULL,
  rev INT NOT NULL,
  deleted_by TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_at TIMESTAMPTZ NOT NULL          -- ครบกำหนดเวลานี้แล้วลบทิ้งจริงถาวร
);
CREATE INDEX IF NOT EXISTS idx_trash_purge_at ON branches_trash(purge_at);

-- ประวัติการแก้ไข (log)
CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  t TIMESTAMPTZ NOT NULL DEFAULT now(),
  who TEXT,
  branch TEXT,
  action TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_t ON logs(t DESC);
