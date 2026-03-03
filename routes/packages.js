// routes/packages.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { sendLineFlexMessage } = require("../utils/linePackages");
const { logActivity } = require("../helpers/activity");

// Get packages by role
router.get(
  "/",
  authMiddleware(["owner", "staff", "tenant"]),
  async (req, res) => {
    const role = req.user.role;
    const userId = req.user.id;

    try {
      let rows;

      if (role === "owner" || role === "staff") {
        let sql = `
          SELECT 
            pk.*,
            p.name AS property_name,
            p.address AS property_address,
            u.fullname AS user_fullname,
            r.name AS room_name
          FROM packages pk
          JOIN properties p ON p.id = pk.property_id
          JOIN users u ON u.id = pk.user_id
          LEFT JOIN rooms r ON r.id = pk.room_id
        `;

        if (role === "owner") {
          sql += `
            JOIN property_owners po ON po.property_id = p.id
            WHERE po.owner_id = ?
          `;
        } else if (role === "staff") {
          sql += `
            JOIN property_staff ps ON ps.property_id = p.id
            WHERE ps.staff_id = ?
          `;
        }

        [rows] = await pool.execute(sql, [userId]);
      } else if (role === "tenant") {
        // tenant: ดูพัสดุของตัวเองเท่านั้น
        [rows] = await pool.execute(
          `
            SELECT 
              pk.*,
              p.name AS property_name,
              p.address AS property_address,
              u.fullname AS user_fullname
            FROM packages pk
            JOIN properties p ON p.id = pk.property_id
            JOIN users u ON u.id = pk.user_id
            WHERE pk.user_id = ?
          `,
          [userId]
        );
      }

      res.json(rows);
    } catch (err) {
      console.error("Error in GET /packages:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

// Create package (staff/owner)
router.post("/", authMiddleware(["staff", "owner"]), async (req, res) => {
  try {
    const { property_id, name, description, price, user_id, room_id } = req.body;

    console.log("Payload to /packages:", req.body);

    if (!property_id || !name) {
      return res
        .status(400)
        .json({ message: "property_id และ name จำเป็นต้องมี" });
    }

    const [result] = await pool.execute(
      `INSERT INTO packages 
      (property_id, room_id, name, description, price, user_id, created_at) 
      VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [property_id, room_id || null, name, description || null, price || 0, user_id || null]
    );

    // console.log("Inserted package ID:", result.insertId);
    await logActivity(
      req.user.id, // ผู้ทำรายการ
      "create_package", // action
      "package", // entity type
      result.insertId, // entity id
      `${
        req.user.username || "ไม่ทราบผู้ใช้"
      } เพิ่มแพ็กเกจ ${name} ในหอพัก ID ${property_id}`
    );

    res.json({ message: "Package created", id: result.insertId });
  } catch (err) {
    console.error(err); // log error
    res.status(500).json({ message: err.message });
  }
});
// ส่งแจ้งเตือนพัสดุทาง LINE
router.post(
  "/notify/:id",
  authMiddleware(["owner", "staff", "tenant"]),
  async (req, res) => {
    try {
      const packageId = req.params.id;

      // ดึงข้อมูลพัสดุ + ผู้รับ
      const [[pkg]] = await pool.execute(
        `SELECT 
        pk.*, u.fullname, u.id_line,
        r.name AS room_name,
        p.name AS property_name
       FROM packages pk
       JOIN users u ON u.id = pk.user_id
       LEFT JOIN rents b ON b.user_id = u.id
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN properties p ON p.id = pk.property_id
       WHERE pk.id = ?`,
        [packageId]
      );

      if (!pkg) return res.status(404).json({ message: "ไม่พบพัสดุ" });
      if (!pkg.id_line)
        return res.status(400).json({ message: "ผู้ใช้ยังไม่ได้ผูก LINE" });

      // สร้าง Flex Message
      const flexMessage = {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "text",
              text: "📦 แจ้งพัสดุใหม่",
              weight: "bold",
              size: "lg",
              color: "#1976d2",
            },
            {
              type: "text",
              text: `${pkg.property_name} • ห้อง ${pkg.room_name}`,
              size: "sm",
              wrap: true,
              margin: "sm",
            },
            {
              type: "text",
              text: `ผู้รับ: ${pkg.fullname}`,
              size: "sm",
              wrap: true,
              margin: "sm",
            },
            {
              type: "text",
              text: `ชื่อพัสดุ: ${pkg.name}`,
              size: "sm",
              wrap: true,
              margin: "sm",
            },
            {
              type: "text",
              text: `รายละเอียด: ${pkg.description || "-"}`,
              size: "sm",
              wrap: true,
              margin: "sm",
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            {
              type: "text",
              text: "กรุณาตรวจสอบและยืนยันพัสดุในระบบด้วย",
              size: "sm",
              color: "#777777",
              wrap: true,
            },
          ],
        },
      };

      await sendLineFlexMessage(pkg.id_line, flexMessage);

      res.json({ message: "ส่งแจ้งเตือนพัสดุเรียบร้อยแล้ว" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  }
);

// Update package (staff/owner)
router.put("/:id", authMiddleware(["staff", "owner"]), async (req, res) => {
  try {
    const { name, description, price, user_id, room_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "ผู้รับพัสดุต้องถูกระบุ" });
    }

    await pool.execute(
      `UPDATE packages 
      SET name=?, description=?, price=?, user_id=?, room_id=? 
      WHERE id=?`,
      [name, description, price, user_id, room_id || null, req.params.id]
    );

    await logActivity(
      req.user.id,
      "update_package",
      "package",
      req.params.id,
      `${req.user.username || "ไม่ทราบผู้ใช้"} แก้ไขแพ็กเกจ ${name}`
    );

    res.json({ message: "Package updated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// Update package (tenant)
router.put("/tenant/:id", async (req, res) => {
  try {
    const { name, description, price, status } = req.body;
    const packageId = req.params.id;

    // ดึงสถานะปัจจุบันก่อน
    const [rows] = await pool.execute(
      "SELECT status FROM packages WHERE id = ?",
      [packageId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Package not found" });
    }

    const currentStatus = rows[0].status;

    // ถ้าเคยกดรับแล้ว ห้ามแก้กลับ
    if (currentStatus === "received" && status !== "received") {
      return res.status(400).json({ message: "ไม่สามารถยกเลิกการรับพัสดุได้" });
    }

    const fields = [];
    const values = [];

    if (name !== undefined) {
      fields.push("name = ?");
      values.push(name);
    }
    if (description !== undefined) {
      fields.push("description = ?");
      values.push(description);
    }
    if (price !== undefined) {
      fields.push("price = ?");
      values.push(price);
    }
    if (status !== undefined) {
      fields.push("status = ?");
      values.push(status);

      // ถ้ากดรับ → บันทึกเวลา
      if (status === "received") {
        fields.push("received_at = CURRENT_TIMESTAMP");
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    values.push(packageId);

    const sql = `UPDATE packages SET ${fields.join(", ")} WHERE id = ?`;
    await pool.execute(sql, values);

    await logActivity(
      req.user?.id || null, // ถ้าใช้ auth middleware, req.user.id จะมี
      "update_package_tenant", // action
      "package", // entity type
      packageId, // entity id
      `Tenant ${req.user?.username || "ไม่ทราบผู้ใช้"} แก้ไขแพ็กเกจ ${
        name || ""
      }` // description
    );

    res.json({ message: "Package updated" });
  } catch (err) {
    console.error("Error updating package:", err);
    res.status(500).json({ message: err.message });
  }
});
// Delete package (admin/staff/owner)
router.delete(
  "/:id",
  authMiddleware(["admin", "staff", "owner"]),
  async (req, res) => {
    try {
      await pool.execute("DELETE FROM packages WHERE id=?", [req.params.id]);
      res.json({ message: "Package deleted" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

module.exports = router;
