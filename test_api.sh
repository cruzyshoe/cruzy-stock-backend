#!/bin/bash
set -e
BASE=http://localhost:3001/api
echo "=== 1) สร้างสาขา A ==="
curl -s -X PUT $BASE/branches/bA -H "Content-Type: application/json" -d '{"name":"สาขา A","payload":{"bid":"bA","name":"สาขา A","arrange":[[[[]]]]},"updatedBy":"dev1"}' | python3 -m json.tool

echo "=== 2) สร้างสาขา B ==="
curl -s -X PUT $BASE/branches/bB -H "Content-Type: application/json" -d '{"name":"สาขา B","payload":{"bid":"bB","name":"สาขา B","arrange":[[[[]]]]},"updatedBy":"dev2"}' | python3 -m json.tool

echo "=== 3) ดูรายชื่อสาขาทั้งหมด (ต้องมี 2 สาขา) ==="
curl -s $BASE/branches | python3 -m json.tool

echo "=== 4) ลบสาขา A (ต้องเข้าถังขยะ ไม่ใช่หายเลย) ==="
curl -s -X DELETE "$BASE/branches/bA?by=dev1" | python3 -m json.tool

echo "=== 5) ดูรายชื่อสาขา (ต้องเหลือแค่ B) ==="
curl -s $BASE/branches | python3 -m json.tool

echo "=== 6) ดูถังขยะ (ต้องเจอ A) ==="
curl -s $BASE/trash | python3 -m json.tool

echo "=== 7) กู้คืนสาขา A ==="
curl -s -X POST $BASE/trash/bA/restore | python3 -m json.tool

echo "=== 8) ดูรายชื่อสาขาอีกครั้ง (ต้องมี A กลับมา + B) ==="
curl -s $BASE/branches | python3 -m json.tool

echo "=== 9) ถังขยะต้องว่างแล้ว ==="
curl -s $BASE/trash | python3 -m json.tool
