// routes/tenant.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { logActivity } = require("../helpers/activity");

// Get tenants (including guests) by property/room
router.get("/", authMiddleware(["owner", "staff"]), async (req, res) => {
  try {
    const userId = req.user.id;
    const { property_id, room_id } = req.query;

    // SQL สำหรับ tenant + guest
    let tenantSql = `
      SELECT
        u.id AS tenant_id,
        u.username,
        u.fullname,
        u.email,
        u.phone,
        u.id_line,
        u.line,
        u.role,
        u.profile_image,
        p.id AS property_id,
        p.name AS property_name,
        p.address AS property_address,
        r.id AS room_id,
        r.name AS room_name,
        b.id AS booking_id,
        b.billing_cycle, 
        b.start_date,
        b.end_date,
        b.status
      FROM users u
      JOIN rents b ON u.id = b.user_id
      JOIN rooms r ON b.room_id = r.id
      JOIN properties p ON r.property_id = p.id
      WHERE u.role = 'tenant'
      AND b.status IN ('confirmed', 'cancelled')
      AND (
        EXISTS (
          SELECT 1 FROM property_owners po
          WHERE po.property_id = p.id AND po.owner_id = ?
        )
        OR EXISTS (
          SELECT 1 FROM property_staff ps
          WHERE ps.property_id = p.id AND ps.staff_id = ?
        )
      )
    `;

    const tenantParams = [userId, userId];

    if (property_id) {
      tenantSql += " AND p.id = ? ";
      tenantParams.push(property_id);
    }

    if (room_id) {
      tenantSql += " AND r.id = ? ";
      tenantParams.push(room_id);
    }

    // รวมและเรียงตาม booking ล่าสุด
    const sql = `
      SELECT * FROM (${tenantSql}) AS combined
      ORDER BY booking_id DESC
    `;

    const [rows] = await pool.execute(sql, tenantParams);

    // Group ตาม tenant_id
    const tenantsMap = new Map();
    rows.forEach((row) => {
      if (!tenantsMap.has(row.tenant_id)) {
        tenantsMap.set(row.tenant_id, {
          id: row.tenant_id,
          username: row.username,
          fullname: row.fullname,
          email: row.email,
          phone: row.phone,
          id_line: row.id_line,
          line: row.line,
          role: row.role,
          profile_image: row.profile_image,
          bookings: [],
        });
      }

      // เพิ่ม booking
      if (row.room_id) {
        const tenant = tenantsMap.get(row.tenant_id);
        const bookingKey = `${row.room_id}_${row.start_date}`;
        if (
          !tenant.bookings.some(
            (b) => `${b.room_id}_${b.start_date}` === bookingKey
          )
        ) {
          tenant.bookings.push({
            property_id: row.property_id,
            property_name: row.property_name,
            property_address: row.property_address,
            room_id: row.room_id,
            room_name: row.room_name,
            start_date: row.start_date,
            end_date: row.end_date,
            status: row.status,
            billing_cycle: row.billing_cycle,
          });
        }
      }
    });

    // แปลงเป็น array และเพิ่มสถานะล่าสุด
    const tenantsArray = Array.from(tenantsMap.values());
    tenantsArray.forEach((tenant) => {
      if (tenant.bookings && tenant.bookings.length > 0) {
        tenant.status = tenant.bookings[0].status;
      } else {
        tenant.status = null;
      }
    });

    res.json(tenantsArray);
  } catch (err) {
    console.error("Error fetching tenants/guests:", err);
    res.status(500).json({ message: err.message });
  }
});

// POST add tenant
router.post("/", authMiddleware(["owner", "staff"]), async (req, res) => {
  const {
    username,
    fullname,
    password_hash,
    property_ids,
    room_ids,
    start_date,
    end_date,
    status,
    billing_cycles, // ✅ เพิ่มมาจาก frontend
  } = req.body;
  const bcrypt = require("bcrypt");

  const connection = await pool.getConnection();
  try {
    const hashedPassword = await bcrypt.hash(password_hash, 10);

    await connection.beginTransaction();

    // Create tenant user
    const [userResult] = await connection.execute(
      "INSERT INTO users (username, fullname, password_hash, role) VALUES (?, ?, ?, 'tenant')",
      [username, fullname, hashedPassword]
    );
    const tenantId = userResult.insertId;

    const today = new Date();
    const nextYear = new Date();
    nextYear.setFullYear(today.getFullYear() + 1);
    const defaultStart = start_date || today.toISOString().split("T")[0];
    const defaultEnd = end_date || nextYear.toISOString().split("T")[0];
    const bookingStatus = status || "confirmed";

    // Create bookings
    for (let i = 0; i < room_ids.length; i++) {
      const roomId = room_ids[i];
      const propertyId = property_ids[i];

      // ตรวจสอบว่าห้องอยู่ใน property
      const [roomCheck] = await connection.execute(
        "SELECT id FROM rooms WHERE id = ? AND property_id = ?",
        [roomId, propertyId]
      );
      if (roomCheck.length === 0) {
        await connection.rollback();
        return res
          .status(400)
          .json({ message: `ห้อง ${roomId} ไม่อยู่ในหอพัก ${propertyId}` });
      }

      // ตรวจสอบว่าห้องถูกจองแล้วหรือยัง
      const [existingBooking] = await connection.execute(
        `SELECT * FROM rents 
         WHERE room_id = ? AND status = 'confirmed' 
           AND NOT (end_date < ? OR start_date > ?)`,

        [roomId, defaultStart, defaultEnd]
      );
      if (existingBooking.length > 0) {
        await connection.rollback();
        return res.status(400).json({ message: `ห้อง ${roomId} ถูกจองแล้ว` });
      }

      // Insert booking
      await connection.execute(
        `INSERT INTO rents 
        (user_id, room_id, status, start_date, end_date, billing_cycle) 
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          roomId,
          bookingStatus,
          defaultStart,
          defaultEnd,
          billing_cycles?.[roomId] || "monthly",
        ]
      );
    }

    await connection.commit();
    await logActivity(
      req.user.id,
      "add_tenant",
      "user",
      tenantId,
      `${req.user.username || "ไม่ทราบผู้ใช้"} เพิ่มผู้เช่าใหม่ชื่อ ${fullname}`
    );
    res.json({ message: "Tenant added", tenantId });
  } catch (err) {
    await connection.rollback();
    console.error("ADD TENANT ERROR:", err);
    res.status(500).json({ message: err.message });
  } finally {
    connection.release();
  }
});

// PUT update tenant
router.put("/:id", authMiddleware(["owner", "staff"]), async (req, res) => {
  const { id } = req.params;
  const {
    username,
    fullname,
    password_hash,
    property_ids,
    room_ids,
    start_date,
    end_date,
    status,
    billing_cycles,
  } = req.body;
  const bcrypt = require("bcrypt");

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1️⃣ Update tenant user (password ถ้าไม่ส่งมา จะไม่แก้)
    let updateQuery = "UPDATE users SET username=?, fullname=?";
    const updateParams = [username, fullname];

    if (password_hash && password_hash.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password_hash, 10);
      updateQuery += ", password_hash=?";
      updateParams.push(hashedPassword);
    }

    // เพิ่มเงื่อนไขให้ guest กลายเป็น tenant
    updateQuery +=
      ", role = CASE WHEN role = 'guest' THEN 'tenant' ELSE role END";

    // เงื่อนไข WHERE: id ที่ส่งมา
    updateQuery += " WHERE id=?";
    updateParams.push(id);

    await connection.execute(updateQuery, updateParams);

    const today = new Date();
    const nextYear = new Date();
    nextYear.setFullYear(today.getFullYear() + 1);
    const defaultStart = start_date || today.toISOString().split("T")[0];
    const defaultEnd = end_date || nextYear.toISOString().split("T")[0];
    const bookingStatus = status || "confirmed";

    // 2️⃣ เคลียร์ booking เก่าของ tenant
    await connection.execute("DELETE FROM rents WHERE user_id = ?", [id]);

    // 3️⃣ Insert booking ใหม่สำหรับทุกห้อง
    for (let i = 0; i < room_ids.length; i++) {
      const roomId = room_ids[i];
      const propertyId = property_ids[i] || property_ids[0]; // fallback
      // ตรวจสอบห้องอยู่ใน property
      const [roomCheck] = await connection.execute(
        "SELECT id FROM rooms WHERE id = ? AND property_id = ?",
        [roomId, propertyId]
      );
      if (roomCheck.length === 0) {
        await connection.rollback();
        return res
          .status(400)
          .json({ message: `ห้อง ${roomId} ไม่อยู่ในหอพัก ${propertyId}` });
      }

      // ตรวจสอบว่าห้องถูกจองแล้วหรือไม่
      const [existingBooking] = await connection.execute(
        `SELECT * FROM bookings
         WHERE room_id = ? AND status = 'confirmed'
           AND NOT (end_date < ? OR start_date > ?)`,
        [roomId, defaultStart, defaultEnd]
      );
      if (existingBooking.length > 0) {
        await connection.rollback();
        return res.status(400).json({ message: `ห้อง ${roomId} ถูกจองแล้ว` });
      }

      // Insert booking ใหม่
      await connection.execute(
        `INSERT INTO rents 
        (user_id, room_id, status, start_date, end_date, billing_cycle) 
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          roomId,
          bookingStatus,
          defaultStart,
          defaultEnd,
          billing_cycles?.[roomId] || "monthly",
        ]
      );
    }

    await connection.commit();
    await logActivity(
      req.user.id,
      "edit_tenant",
      "user",
      id,
      `${req.user.username || "ไม่ทราบผู้ใช้"} แก้ไขข้อมูลผู้เช่า ${fullname || username}`
    );
    res.json({ message: "Tenant updated" });
  } catch (err) {
    await connection.rollback();
    console.error("EDIT TENANT ERROR:", err);
    res.status(500).json({ message: err.message });
  } finally {
    connection.release();
  }
});

// DELETE tenant 
router.delete("/:id", authMiddleware(["owner", "staff"]), async (req, res) => {
  const { id } = req.params;
  const user = req.user;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // ✅ ตรวจสอบว่ามี booking ที่ยังไม่ถูกยกเลิกหรือไม่
    const [activeBookings] = await connection.execute(
      `
      SELECT id 
      FROM bookings 
      WHERE user_id = ? 
      AND status != 'cancelled'
      LIMIT 1
      `,
      [id]
    );

    // ❌ ถ้ายังมี pending หรือ confirmed → ห้ามลบ
    if (activeBookings.length > 0) {
      await connection.rollback();
      return res.status(400).json({
        message: "ไม่สามารถลบผู้เช่าได้ เนื่องจากยังมีสัญญาที่ยังไม่ถูกยกเลิก",
      });
    }

    // ✅ ลบผู้เช่า (tenant)
    const [result] = await connection.execute(
      "DELETE FROM users WHERE id=? AND role='tenant'",
      [id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "ไม่พบข้อมูลผู้เช่าที่ต้องการลบ",
      });
    }

    // ✅ บันทึกกิจกรรม
    await logActivity(
      user.id,
      "delete_tenant",
      "user",
      id,
      `${user.username || "ไม่ทราบผู้ใช้"} ได้ลบผู้เช่า (ID: ${id})`
    );

    await connection.commit();
    res.json({ message: "ลบผู้เช่าสำเร็จ" });

  } catch (err) {
    await connection.rollback();
    console.error("DELETE TENANT ERROR:", err);
    res.status(500).json({ message: err.message });
  } finally {
    connection.release();
  }
});

// ✅ ยืนยันผู้เช่า (อัปเดตสถานะ booking เป็น confirmed + เปลี่ยน role guest → tenant)
router.put("/confirm/:id", authMiddleware(["owner", "staff"]), async (req, res) => {
  const { id } = req.params; // แก้จาก tenantId → id เพื่อให้ตรงกับ URL

  try {
    // ✅ อัปเดต booking จาก pending → confirmed
    const [result] = await pool.execute(
      `UPDATE bookings 
       SET status = 'confirmed' 
       WHERE user_id = ? AND status = 'pending'`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "ไม่พบข้อมูลผู้เช่าที่รออนุมัติ" });
    }

    // ✅ เปลี่ยน role จาก guest → tenant (ถ้ายังเป็น guest อยู่)
    await pool.execute(
      `UPDATE users 
       SET role = 'tenant' 
       WHERE id = ? AND role = 'guest'`,
      [id]
    );

    // ✅ บันทึกกิจกรรม (ถ้ามีระบบ logActivity)
    await logActivity(
      req.user.id,
      "confirm_tenant",
      "user",
      id,
      `${req.user.username || "ไม่ทราบผู้ใช้"} ยืนยันผู้เช่า (ID: ${id})`
    );

    res.json({ message: "ยืนยันผู้เช่าสำเร็จ และอัปเดตสถานะเป็นผู้เช่าแล้ว" });
  } catch (err) {
    console.error("CONFIRM TENANT ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
