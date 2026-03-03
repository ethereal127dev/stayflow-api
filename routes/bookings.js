// routes/bookings.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
// Get all bookings (admin) 
router.get("/", authMiddleware(["admin"]), async (req, res) => {
  try {
    const role = req.user.role;

    let query = `
      SELECT 
        b.id AS booking_id,
        b.status AS booking_status,
        b.start_date,
        b.end_date,
        b.billing_cycle,
        u.id AS user_id,
        u.username,
        u.fullname,
        u.email,
        r.id AS room_id,
        r.name AS room_name,
        r.price_monthly,
        r.price_term,
        p.id AS property_id,
        p.name AS property_name,
        p.address AS property_address
      FROM rents b
      JOIN users u ON b.user_id = u.id
      JOIN rooms r ON b.room_id = r.id
      JOIN properties p ON r.property_id = p.id
    `;

    const params = [];
    if (role !== "admin") {
      query += " WHERE b.user_id = ?";
      params.push(req.user.id);
    }

    // เรียงจากใหม่ไปเก่า
    query += " ORDER BY b.start_date DESC";
    
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});
// get bookings ของ owner/staff ที่เกี่ยวข้องกับหอที่ตัวเองดูแล
router.get('/my', authMiddleware(['owner','staff']), async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!userId || (userRole !== 'owner' && userRole !== 'staff')) {
      return res.status(403).json({ message: 'ไม่มีสิทธิ์เข้าถึงข้อมูล' });
    }

    let query = `
      SELECT 
        b.id AS booking_id,
        b.status AS booking_status,
        b.start_date,
        b.end_date,
        b.billing_cycle AS billing_cycle,
        u.id AS user_id,
        u.username,
        u.fullname,
        u.email,
        r.id AS room_id,
        r.name AS room_name,
        r.price_monthly AS price_monthly,
        r.price_term AS price_term,
        p.id AS property_id,
        p.name AS property_name,
        p.address AS property_address
      FROM rents b
      JOIN users u ON b.user_id = u.id
      JOIN rooms r ON b.room_id = r.id
      JOIN properties p ON r.property_id = p.id
      WHERE 1=1
    `;

    const params = [];

    if (userRole === 'owner') {
      query += ` AND p.id IN (SELECT property_id FROM property_owners WHERE owner_id = ?)`;
      params.push(userId);
    } else if (userRole === 'staff') {
      query += ` AND p.id IN (SELECT property_id FROM property_staff WHERE staff_id = ?)`;
      params.push(userId);
    }

    query += ` ORDER BY b.start_date DESC`;

    // ใช้ pool.execute แทน db.query
    const [bookings] = await pool.execute(query, params);

    res.json(bookings);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในการดึงข้อมูลการจอง' });
  }
});
// Get bookings ของ tenant พร้อม room และ property
router.get(
  "/tenant/my",
  authMiddleware(["tenant"]),
  async (req, res) => {
    const userId = req.user.id;
    try {
      const [rows] = await pool.execute(`
        SELECT 
          b.id AS booking_id,
          b.start_date,
          b.end_date,
          b.status AS booking_status,
          b.billing_cycle,
          r.id AS room_id,
          r.name AS room_name,
          r.price_monthly,
          r.price_term,
          r.has_ac,
          r.has_fan,
          p.id AS property_id,
          p.name AS property_name,
          p.address AS property_address
        FROM rents b
        JOIN rooms r ON r.id = b.room_id
        JOIN properties p ON p.id = r.property_id
        WHERE b.user_id = ?
      `, [userId]);

      // Map billing_cycle → price
      const bookings = rows.map(b => {
        let price = 0;
        if (b.billing_cycle === 'monthly') price = b.price_monthly;
        else if (b.billing_cycle === 'term') price = b.price_term;

        return {
          ...b,
          price: parseFloat(price).toFixed(2), // ส่งเป็น string "4500.00"
        };
      });

      res.json(bookings);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  }
);


// Create booking (tenant)
router.post("/", authMiddleware(["tenant"]), async (req, res) => {
  const { room_id, start_date, end_date } = req.body;
  const [result] = await pool.execute(
    "INSERT INTO bookings (user_id, room_id, start_date, end_date) VALUES (?,?,?,?)",
    [req.user.id, room_id, start_date, end_date]
  );
  res.json({ message: "Booking created", id: result.insertId });
});

// Update booking (admin/tenant)
router.put("/:id", authMiddleware(["admin", "tenant"]), async (req, res) => {
  const { room_id, start_date, end_date } = req.body;
  await pool.execute(
    "UPDATE bookings SET room_id=?, start_date=?, end_date=? WHERE id=?",
    [room_id, start_date, end_date, req.params.id]
  );
  res.json({ message: "Booking updated" });
});

// Delete booking (admin/tenant)
router.delete("/:id", authMiddleware(["admin", "tenant"]), async (req, res) => {
  await pool.execute("DELETE FROM bookings WHERE id=?", [req.params.id]);
  res.json({ message: "Booking deleted" });
});

module.exports = router;
