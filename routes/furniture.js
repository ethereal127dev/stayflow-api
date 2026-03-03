// backend/routes/furniture.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

// GET /furniture - ดึงรายการเฟอร์นิเจอร์ของ staff
router.get("/", authMiddleware(["staff"]), async (req, res) => {
  try {
    const staffId = req.user.id;

    // ดึง property ที่ staff ดูแล
    const [properties] = await pool.execute(
      "SELECT ps.property_id, p.name AS property_name FROM property_staff ps JOIN properties p ON ps.property_id = p.id WHERE ps.staff_id = ?",
      [staffId]
    );

    if (properties.length === 0) return res.json([]);

    const propertyIds = properties.map((p) => p.property_id);

    // ดึงเฟอร์นิเจอร์ทั้งหมดที่เกี่ยวข้องกับ property เหล่านั้น
    const [furnitures] = await pool.execute(
      `SELECT 
          rf.id, rf.name, rf.quantity, rf.room_id,
          r.name AS room_name, r.property_id,
          p.name AS property_name
       FROM room_furnitures rf
       JOIN rooms r ON rf.room_id = r.id
       JOIN properties p ON r.property_id = p.id
       WHERE r.property_id IN (${propertyIds.map(() => "?").join(",")})
       ORDER BY p.name, r.name`,
      propertyIds
    );

    // จัดกลุ่มข้อมูลตาม property_name
    const grouped = properties.map((prop) => ({
      property_id: prop.property_id,
      property_name: prop.property_name,
      furnitures: furnitures.filter((f) => f.property_id === prop.property_id),
    }));

    res.json(grouped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูลเฟอร์นิเจอร์" });
  }
});
// ดึงหอของ staff
router.get("/staff/properties", authMiddleware(["staff"]), async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT p.id, p.name 
     FROM property_staff ps 
     JOIN properties p ON ps.property_id = p.id 
     WHERE ps.staff_id = ?`,
    [req.user.id]
  );
  res.json(rows);
});

// ดึงห้องตาม property
router.get("/rooms/byProperty/:property_id", authMiddleware(["staff"]), async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, name 
     FROM rooms 
     WHERE property_id = ? 
     ORDER BY name`,
    [req.params.property_id]
  );
  res.json(rows);
});
/**
 * POST /furniture
 * เพิ่มเฟอร์นิเจอร์
 * body: { name, quantity, room_id }
 */
router.post("/", authMiddleware(["staff"]), async (req, res) => {
  try {
    const staffId = req.user.id;
    const { name, quantity, room_id } = req.body;

    // ตรวจสอบว่า room อยู่ใน property ของ staff
    const [rows] = await pool.execute(
      `SELECT r.id FROM rooms r
       JOIN property_staff ps ON r.property_id = ps.property_id
       WHERE r.id = ? AND ps.staff_id = ?`,
      [room_id, staffId]
    );
    if (rows.length === 0) {
      return res.status(403).json({ message: "คุณไม่สามารถแก้ไขห้องนี้ได้" });
    }

    const [result] = await pool.execute(
      `INSERT INTO room_furnitures (room_id, name, quantity, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [room_id, name, quantity]
    );

    res.json({ id: result.insertId, name, quantity, room_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการเพิ่มเฟอร์นิเจอร์" });
  }
});

/**
 * PUT /furniture/:id
 * แก้ไขเฟอร์นิเจอร์
 * body: { name, quantity, room_id }
 */
router.put("/:id", authMiddleware(["staff"]), async (req, res) => {
  try {
    const staffId = req.user.id;
    const { name, quantity, room_id } = req.body;
    const furnitureId = req.params.id;

    // ตรวจสอบว่าเฟอร์นิเจอร์อยู่ใน property ของ staff
    const [rows] = await pool.execute(
      `SELECT rf.id FROM room_furnitures rf
       JOIN rooms r ON rf.room_id = r.id
       JOIN property_staff ps ON r.property_id = ps.property_id
       WHERE rf.id = ? AND ps.staff_id = ?`,
      [furnitureId, staffId]
    );
    if (rows.length === 0) {
      return res.status(403).json({ message: "คุณไม่สามารถแก้ไขเฟอร์นิเจอร์นี้ได้" });
    }

    await pool.execute(
      `UPDATE room_furnitures 
       SET name = ?, quantity = ?, room_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [name, quantity, room_id, furnitureId]
    );

    res.json({ id: furnitureId, name, quantity, room_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการแก้ไขเฟอร์นิเจอร์" });
  }
});

/**
 * DELETE /furniture/:id
 * ลบเฟอร์นิเจอร์
 */
router.delete("/:id", authMiddleware(["staff"]), async (req, res) => {
  try {
    const staffId = req.user.id;
    const furnitureId = req.params.id;

    // ตรวจสอบสิทธิ์
    const [rows] = await pool.execute(
      `SELECT rf.id FROM room_furnitures rf
       JOIN rooms r ON rf.room_id = r.id
       JOIN property_staff ps ON r.property_id = ps.property_id
       WHERE rf.id = ? AND ps.staff_id = ?`,
      [furnitureId, staffId]
    );
    if (rows.length === 0) {
      return res.status(403).json({ message: "คุณไม่สามารถลบเฟอร์นิเจอร์นี้ได้" });
    }

    await pool.execute(`DELETE FROM room_furnitures WHERE id = ?`, [furnitureId]);
    res.json({ message: "ลบเฟอร์นิเจอร์เรียบร้อยแล้ว" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการลบเฟอร์นิเจอร์" });
  }
});

module.exports = router;
