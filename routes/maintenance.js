// routes/maintenance.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { logActivity } = require("../helpers/activity");
// Get maintenance requests for owner/staff
router.get("/", authMiddleware(["owner", "staff"]), async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let query = `
      SELECT 
        mr.id,
        mr.user_id,
        mr.room_id,
        mr.description,
        mr.status,
        mr.created_at,
        mr.updated_at,
        u.username,
        u.fullname,
        r.name AS room_name,
        p.id AS property_id,
        p.name AS property_name
      FROM maintenance_requests mr
      JOIN users u ON mr.user_id = u.id
      JOIN rooms r ON mr.room_id = r.id
      JOIN properties p ON r.property_id = p.id
      WHERE 1=1
    `;

    const params = [];

    if (userRole === "owner") {
      query += ` AND p.id IN (SELECT property_id FROM property_owners WHERE owner_id = ?)`;
      params.push(userId);
    } else if (userRole === "staff") {
      query += ` AND p.id IN (SELECT property_id FROM property_staff WHERE staff_id = ?)`;
      params.push(userId);
    }

    query += ` ORDER BY mr.created_at DESC`;

    const [maintenanceRequests] = await pool.execute(query, params);

    res.json(maintenanceRequests);
  } catch (error) {
    console.error("Error fetching maintenance requests:", error);
    res
      .status(500)
      .json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูลคำขอซ่อมแซม" });
  }
});
// GET /api/maintenance/tenant - ดึงรายการแจ้งซ่อมของ tenant
router.get("/tenant", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.execute(
      `
      SELECT mr.id AS maintenance_id,
             mr.user_id,
             mr.room_id,
             r.name AS room_name,
             r.property_id,
             p.name AS property_name,
             p.address AS property_address,
             mr.description,
             mr.status,
             mr.created_at,
             mr.updated_at
      FROM maintenance_requests mr
      JOIN rooms r ON r.id = mr.room_id
      JOIN properties p ON p.id = r.property_id
      WHERE mr.user_id = ?
      ORDER BY mr.created_at DESC
      `,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// GET /api/maintenance/tenant/rooms - ดึงห้องของ tenant
router.get("/tenant/rooms", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.execute(
      `
      SELECT r.id AS room_id, r.name AS room_name, r.property_id
      FROM rents b
      JOIN rooms r ON r.id = b.room_id
      WHERE b.user_id = ? AND b.status = 'confirmed'
      `,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// เพิ่มคำร้องซ่อม (tenant) - ทีละห้อง
router.post("/", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const { room_id, description } = req.body;

    if (!room_id || !description) {
      return res
        .status(400)
        .json({ message: "room_id and description are required" });
    }

    // ตรวจสอบว่า room นี้เป็นของ tenant
    const [rows] = await pool.execute(
      `SELECT b.id 
       FROM bookings b 
       WHERE b.user_id = ? AND b.room_id = ? AND b.status = 'confirmed'`,
      [req.user.id, room_id]
    );

    if (rows.length === 0) {
      return res
        .status(403)
        .json({ message: "คุณไม่สามารถแจ้งซ่อมห้องนี้ได้" });
    }

    const [result] = await pool.execute(
      `INSERT INTO maintenance_requests (user_id, room_id, description, status, created_at)
       VALUES (?, ?, ?, 'pending', NOW())`,
      [req.user.id, room_id, description]
    );
    await logActivity(
      req.user.id,
      "create_maintenance",
      "maintenance_request",
      result.insertId,
      `${req.user.username || "ไม่ทราบผู้ใช้"} สร้างคำร้องซ่อมห้อง ${room_id}`
    );

    res.json({ message: "Maintenance request created", id: result.insertId });
  } catch (err) {
    console.error("Error creating maintenance:", err);
    res.status(500).json({ message: "Error creating maintenance request" });
  }
});
// Update maintenance request (tenant)
router.put("/:id", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const { description, room_id } = req.body; // แก้ไขรับแค่ room_id เดียว
    const maintenanceId = parseInt(req.params.id);

    if (!description || !room_id) {
      return res
        .status(400)
        .json({ message: "กรุณากรอก description และเลือกห้อง" });
    }

    const [result] = await pool.execute(
      `UPDATE maintenance_requests 
       SET description=?, room_id=?, updated_at=NOW() 
       WHERE id=? AND user_id=?`,
      [description, room_id, maintenanceId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "ไม่พบคำร้อง หรือคุณไม่มีสิทธิแก้ไข" });
    }
    await logActivity(
      req.user.id,
      "update_maintenance",
      "maintenance_request",
      maintenanceId,
      `${req.user.username || "ไม่ทราบผู้ใช้"} แก้ไขคำร้องซ่อมห้อง ${room_id}`
    );
    const [updatedRows] = await pool.execute(
      `SELECT * FROM maintenance_requests WHERE id=?`,
      [maintenanceId]
    );

    res.json(updatedRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error updating maintenance request",
      error: err.message,
    });
  }
});
// PUT /maintenance/:id/cancel
router.put("/:id/cancel", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const maintenanceId = parseInt(req.params.id);

    const [result] = await pool.execute(
      `UPDATE maintenance_requests
       SET status='cancelled', updated_at=NOW()
       WHERE id=? AND user_id=? AND status='pending'`,
      [maintenanceId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "ไม่พบคำร้องหรือไม่สามารถยกเลิกได้" });
    }

    await logActivity(
      req.user.id,
      "cancel_maintenance",
      "maintenance_request",
      maintenanceId,
      `${req.user.username || "ไม่ทราบผู้ใช้"} ยกเลิกคำร้องซ่อมห้อง`
    );

    const [updatedRows] = await pool.execute(
      `SELECT * FROM maintenance_requests WHERE id=?`,
      [maintenanceId]
    );

    res.json(updatedRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error cancelling maintenance request",
      error: err.message,
    });
  }
});

// ✅ อัพเดทสถานะการซ่อม
router.put(
  "/status/:id",
  authMiddleware(["admin", "owner", "staff"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const validStatus = ["pending", "in_progress", "completed"];
      if (!validStatus.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      // ใช้ pool.execute แทน db.query
      const [result] = await pool.execute(
        `UPDATE maintenance_requests 
         SET status = ?, updated_at = NOW()
         WHERE id = ?`,
        [status, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Maintenance request not found" });
      }

      await logActivity(
        req.user.id,
        "update_maintenance_status",
        "maintenance_request",
        id,
        `${
          req.user.username || "ไม่ทราบผู้ใช้"
        } อัปเดตสถานะคำร้องซ่อมเป็น "${status}"`
      );
      res.json({ message: "Status updated successfully" });
    } catch (err) {
      console.error("Error updating status:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);
// Delete maintenance request (tenant)
router.delete("/:id", authMiddleware(["tenant"]), async (req, res) => {
  try {
    await pool.execute(
      `DELETE FROM maintenance_requests WHERE id=? AND user_id=?`,
      [req.params.id, req.user.id]
    );
    res.json({ message: "Maintenance request deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error deleting maintenance request" });
  }
});

module.exports = router;
