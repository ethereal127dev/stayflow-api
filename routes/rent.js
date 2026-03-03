// routes/rent.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

// ดึงค่าเช่าของ tenant ทั้งหมด
router.get("/", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const tenantId = req.user.id;

    // ดึง booking ของ tenant ที่ยัง active
    const [bookings] = await pool.execute(
      `SELECT b.id AS booking_id, b.room_id, b.billing_cycle, b.start_date, b.end_date,
              r.name AS room_name,
              p.name AS property_name, p.address AS property_address
       FROM rents b
       JOIN rooms r ON r.id = b.room_id
       JOIN properties p ON p.id = r.property_id
       WHERE b.user_id = ? AND b.status = 'confirmed'
       ORDER BY b.start_date DESC`,
      [tenantId]
    );

    if (!bookings.length) return res.json([]);

    const rentData = [];

    for (const bk of bookings) {
      // ดึงบิลทั้งหมดของ booking นั้น
      const [bills] = await pool.execute(
        `SELECT *
         FROM bills
         WHERE booking_id = ?
         ORDER BY billing_date DESC, id DESC`,
        [bk.booking_id]
      );

      // ดึง rate น้ำ/ไฟ ของ property
      const [utilities] = await pool.execute(
        `SELECT type, rate
         FROM property_utilities
         WHERE property_id = (
            SELECT property_id FROM rooms WHERE id = ?
         )`,
        [bk.room_id]
      );

      const waterRate = utilities.find((u) => u.type === "water")?.rate || 0;
      const electricRate = utilities.find((u) => u.type === "electric")?.rate || 0;

      // push ค่าเช่าแต่ละบิล
      for (const bill of bills) {
        rentData.push({
          booking_id: bk.booking_id,
          room_name: bk.room_name,
          property_name: bk.property_name,
          property_address: bk.property_address,
          billing_cycle: bk.billing_cycle,
          bill: {
            id: bill.id,
            billing_date: bill.billing_date,
            room_price: bill.room_price,
            water_units: bill.water_units,
            water_rate: waterRate,
            electric_units: bill.electric_units,
            electric_rate: electricRate,
            other_charges: bill.other_charges,
            note: bill.note,
            total_amount: bill.total_amount,
            status: bill.status,
            paid_at: bill.paid_at,
            created_at: bill.created_at,
            updated_at: bill.updated_at,
          },
        });
      }
    }

    res.json(rentData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching rents" });
  }
});

router.put("/:billId/pay", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const { billId } = req.params;
    const tenantId = req.user.id;

    // ตรวจสอบว่าบิลนี้เป็นของ tenant จริง
    const [rows] = await pool.execute(
      `SELECT b.id
       FROM bills b
       JOIN bookings bk ON bk.id = b.booking_id
       WHERE b.id = ? AND bk.user_id = ?`,
      [billId, tenantId]
    );
    if (!rows.length) {
      return res.status(404).json({ message: "ไม่พบบิลนี้" });
    }

    // อัปเดตสถานะบิลเป็น pending
    await pool.execute(
      `UPDATE bills
       SET status = 'pending', paid_at=NOW()
       WHERE id = ?`,
      [billId]
    );

    res.json({ message: "✅ ส่งคำขอชำระค่าเช่าสำเร็จ! รอยืนยันจากเจ้าหน้าที่" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error updating bill status" });
  }
});

module.exports = router;
