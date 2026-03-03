// backend/routes/facilities.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

// 🟢 GET - ดึงรายการสิ่งอำนวยความสะดวกตาม property ของ staff
router.get("/", authMiddleware(["staff"]), async (req, res) => {
  try {
    const staffId = req.user.id;

    // ดึง property ที่ staff ดูแล
    const [properties] = await pool.execute(
      `SELECT p.id, p.name
       FROM property_staff ps
       JOIN properties p ON ps.property_id = p.id
       WHERE ps.staff_id = ?`,
      [staffId],
    );

    if (properties.length === 0) return res.json([]);

    const propertyIds = properties.map((p) => p.id);

    // ดึงสิ่งอำนวยความสะดวกของ property
    const [facilities] = await pool.execute(
      `SELECT id, property_id, name, icon
   FROM property_facilities
   WHERE property_id IN (${propertyIds.map(() => "?").join(",")})
   ORDER BY id DESC`,
      propertyIds,
    );

    // จัดกลุ่มตาม property
    const result = properties.map((p) => ({
      property_id: p.id,
      property_name: p.name,
      facilities: facilities.filter((f) => f.property_id === p.id),
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /facilities error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
  }
});

// 🟡 POST - เพิ่มสิ่งอำนวยความสะดวกใหม่
router.post("/", authMiddleware(["staff"]), async (req, res) => {
  try {
    const { name, icon, property_id } = req.body;
    if (!name || !icon || !property_id)
      return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบ" });

    await pool.execute(
      `INSERT INTO property_facilities (property_id, name, icon)
   VALUES (?, ?, ?)`,
      [property_id, name, icon],
    );

    res.json({ message: "เพิ่มสิ่งอำนวยความสะดวกเรียบร้อยแล้ว" });
  } catch (err) {
    console.error("POST /facilities error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการเพิ่มข้อมูล" });
  }
});

// 🟠 PUT - แก้ไขสิ่งอำนวยความสะดวก
router.put("/:id", authMiddleware(["staff"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, icon, property_id } = req.body;

    if (!name || !icon || !property_id)
      return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบ" });

    const [result] = await pool.execute(
      `UPDATE property_facilities
       SET name = ?, icon = ?, property_id = ?
       WHERE id = ?`,
      [name, icon, property_id, id],
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "ไม่พบข้อมูลที่ต้องการแก้ไข" });

    res.json({ message: "แก้ไขข้อมูลเรียบร้อยแล้ว" });
  } catch (err) {
    console.error("PUT /facilities/:id error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการแก้ไขข้อมูล" });
  }
});

// 🔴 DELETE - ลบสิ่งอำนวยความสะดวก
router.delete("/:id", authMiddleware(["staff"]), async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.execute(
      `DELETE FROM property_facilities WHERE id = ?`,
      [id],
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "ไม่พบข้อมูลที่ต้องการลบ" });

    res.json({ message: "ลบข้อมูลเรียบร้อยแล้ว" });
  } catch (err) {
    console.error("DELETE /facilities/:id error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการลบข้อมูล" });
  }
});

module.exports = router;
