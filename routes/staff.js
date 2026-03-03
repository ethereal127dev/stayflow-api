// backend/routes/staff.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const bcrypt = require("bcrypt");
const { logActivity } = require("../helpers/activity");
// get staff
router.get("/", authMiddleware(["owner", "staff"]), async (req, res) => {
  const ownerId = req.user.id;

  try {
    const query = `
      SELECT u.id, u.username, u.fullname, u.email, u.phone, u.line AS id_line,
             u.profile_image, p.id AS property_id, p.name AS property_name, u.role
      FROM users u
      LEFT JOIN property_staff ps ON ps.staff_id = u.id
      LEFT JOIN property_owners po ON po.property_id = ps.property_id
      LEFT JOIN properties p ON p.id = ps.property_id
      WHERE u.role = 'staff'
        AND po.owner_id = ?
    `;

    const [rows] = await pool.execute(query, [ownerId]);

    const staffMap = {};
    rows.forEach((r) => {
      if (!staffMap[r.id]) {
        staffMap[r.id] = {
          id: r.id,
          username: r.username,
          fullname: r.fullname,
          email: r.email,
          phone: r.phone,
          id_line: r.id_line,
          profile_image: r.profile_image,
          role: r.role,
          properties: [],
          property_names: [],
        };
      }

      if (r.property_id) {
        staffMap[r.id].properties.push({
          id: r.property_id,
          name: r.property_name,
        });
        staffMap[r.id].property_names.push(r.property_name);
      }
    });

    const staffList = Object.values(staffMap).sort((a, b) => b.id - a.id);

    res.json(staffList);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// get property
router.get("/my", authMiddleware(["owner", "staff"]), async (req, res) => {
  const ownerId = req.user.id;
  try {
    const [rows] = await pool.execute(
      `
      SELECT u.id, u.username, u.fullname, u.email, u.phone, u.id_line,
             u.profile_image, p.id AS property_id, p.name AS property_name
      FROM users u
      INNER JOIN property_staff ps ON ps.staff_id = u.id
      INNER JOIN property_owners po ON po.property_id = ps.property_id
      INNER JOIN properties p ON p.id = ps.property_id
      WHERE u.role = 'staff' AND po.owner_id = ?
      ORDER BY u.id, p.id
    `,
      [ownerId],
    );

    // จัด group staff แต่รวม properties เป็น array
    const staffMap = {};
    rows.forEach((r) => {
      if (!staffMap[r.id]) {
        staffMap[r.id] = {
          id: r.id,
          username: r.username,
          fullname: r.fullname,
          email: r.email,
          phone: r.phone,
          id_line: r.id_line,
          profile_image: r.profile_image,
          properties: [],
          property_names: [], // เพิ่ม field สำหรับชื่อหอ
        };
      }
      staffMap[r.id].properties.push({
        id: r.property_id,
        name: r.property_name,
      });
      staffMap[r.id].property_names.push(r.property_name); // เพิ่มชื่อหอ
    });

    res.json(Object.values(staffMap));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// ตรวจสอบ username แบบเรียลไทม์
router.get(
  "/check-username/:username",
  authMiddleware(["owner"]),
  async (req, res) => {
    try {
      const { username } = req.params;
      const { staffId } = req.query; // รับ staffId จาก query string

      // ตรวจสอบรูปแบบ username (ภาษาอังกฤษ/ตัวเลขเท่านั้น, ไม่มีช่องว่าง, ความยาวอย่างน้อย 4 ตัว)
      const usernameRegex = /^[a-zA-Z0-9]{4,}$/;
      if (!usernameRegex.test(username)) {
        return res.status(400).json({
          valid: false,
          message:
            "Username ต้องเป็นภาษาอังกฤษหรือตัวเลขเท่านั้น ไม่มีช่องว่าง และมีความยาวอย่างน้อย 4 ตัวอักษร",
        });
      }

      // ตรวจสอบ username ซ้ำ โดยไม่นับ staffId ตัวเอง (ถ้ามีการส่งมา)
      let query = "SELECT id FROM users WHERE username = ? AND role = 'staff'";
      let params = [username];

      if (staffId) {
        query += " AND id != ?";
        params.push(staffId);
      }

      const [exist] = await pool.execute(query, params);

      if (exist.length > 0) {
        return res.status(200).json({
          valid: false,
          message: "Username ถูกใช้แล้ว",
        });
      }

      return res.status(200).json({
        valid: true,
        message: "Username ใช้ได้",
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);
// ตรวจสอบ email แบบเรียลไทม์
router.get(
  "/check-email/:email",
  authMiddleware(["owner"]),
  async (req, res) => {
    try {
      const { email } = req.params;
      const { staffId } = req.query; // รับ staffId จาก query string

      // ตรวจสอบรูปแบบ email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          valid: false,
          message: "รูปแบบอีเมลไม่ถูกต้อง",
        });
      }

      // ตรวจสอบ email ซ้ำ โดยไม่นับ staffId ตัวเอง (ถ้ามีการส่งมา)
      let query = "SELECT id FROM users WHERE email = ? AND role = 'staff'";
      let params = [email];

      if (staffId) {
        query += " AND id != ?";
        params.push(staffId);
      }

      const [exist] = await pool.execute(query, params);

      if (exist.length > 0) {
        return res.status(200).json({
          valid: false,
          message: "อีเมลถูกใช้แล้ว",
        });
      }

      return res.status(200).json({
        valid: true,
        message: "อีเมลใช้ได้",
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);
// POST เพิ่ม staff ให้หอของ owner
router.post("/", authMiddleware(["owner"]), async (req, res) => {
  const {
    username,
    fullname,
    email,
    phone,
    id_line,
    password,
    profile_image,
    property_ids = [],
  } = req.body;

  try {
    // ตรวจสอบ username ซ้ำ
    const [usernameExist] = await pool.execute(
      "SELECT id FROM users WHERE username = ? AND role = 'staff'",
      [username],
    );

    if (usernameExist.length > 0) {
      return res.status(400).json({ message: "Username ถูกใช้แล้ว" });
    }

    // สร้าง user staff
    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      "INSERT INTO users (username, fullname, email, phone, id_line, profile_image, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, 'staff', ?, NOW())",
      [username, fullname, email, phone, id_line, profile_image, password_hash],
    );

    const staffId = result.insertId;

    // map staff กับ properties ที่เลือก
    if (property_ids.length > 0) {
      const values = property_ids.map((pid) => [pid, staffId, new Date()]);
      await pool.query(
        "INSERT INTO property_staff (property_id, staff_id, created_at) VALUES ?",
        [values],
      );
    }

    await logActivity(
      req.user.id, // id ของ owner ที่ทำการเพิ่ม
      "add_staff", // ประเภทของ action
      "staff", // ประเภทของ entity
      staffId, // id ของ staff ที่ถูกเพิ่ม
      `${
        req.user.username || "ไม่ทราบผู้ใช้"
      } เพิ่มพนักงาน ${fullname} (${username})`,
    );

    res.json({ message: "Staff added", id: staffId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});
// PUT แก้ไข staff
router.put("/:id", authMiddleware(["owner"]), async (req, res) => {
  const { id } = req.params;
  const {
    username,
    fullname,
    email,
    phone,
    id_line,
    password,
    profile_image,
    property_ids = [], // รับ property_ids
  } = req.body;
  const ownerId = req.user.id;

  try {
    // ตรวจสอบ user เป็นของ owner หรือ guest
    const [rows] = await pool.execute(
      `SELECT u.id, u.role FROM users u
       LEFT JOIN property_staff ps ON ps.staff_id = u.id
       LEFT JOIN property_owners po ON po.property_id = ps.property_id
       WHERE u.id = ? AND (po.owner_id = ? OR u.role = 'guest')`,
      [id, ownerId],
    );

    if (!rows.length) return res.status(403).json({ message: "Forbidden" });

    const currentRole = rows[0].role;

    // ตรวจสอบ username ซ้ำ (ยกเว้นตัวเอง)
    const [usernameExist] = await pool.execute(
      "SELECT id FROM users WHERE username = ? AND id != ?",
      [username, id],
    );

    if (usernameExist.length > 0) {
      return res.status(400).json({ message: "Username ถูกใช้แล้ว" });
    }

    // อัปเดตข้อมูล user + แปลง role guest → staff
    let query =
      "UPDATE users SET username=?, fullname=?, email=?, phone=?, id_line=?";
    let params = [username, fullname, email, phone || null, id_line || null];

    // ถ้า guest ให้เปลี่ยน role เป็น staff
    if (currentRole === "guest") {
      query += ", role='staff'";
    }

    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      query += ", password_hash=?";
      params.push(password_hash);
    }

    if (profile_image) {
      query += ", profile_image=?";
      params.push(profile_image);
    }

    query += " WHERE id=?";
    params.push(id);

    await pool.execute(query, params);

    // === อัปเดต property_staff ===
    await pool.execute("DELETE FROM property_staff WHERE staff_id=?", [id]);

    if (property_ids.length > 0) {
      const values = property_ids.map((pid) => [pid, id, new Date()]);
      await pool.query(
        "INSERT INTO property_staff (property_id, staff_id, created_at) VALUES ?",
        [values],
      );
    }

    await logActivity(
      ownerId, // ผู้ทำ (เจ้าของหอ)
      "edit_staff", // action
      "staff", // entity type
      id, // staff ที่ถูกแก้ไข
      `${
        req.user.username || "ไม่ทราบผู้ใช้"
      } แก้ไขข้อมูลพนักงาน ${fullname} (${username})`,
    );

    res.json({ message: "Updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// DELETE ลบ staff และความสัมพันธ์ทั้งหมด
router.delete("/:id", authMiddleware(["owner", "admin"]), async (req, res) => {
  const { id } = req.params;
  const requesterId = req.user.id;
  const requesterRole = req.user.role;

  try {
    // ถ้าเป็น owner ต้องตรวจสอบ staff เป็นของ owner
    if (requesterRole === "owner") {
      const [rows] = await pool.execute(
        `SELECT ps.*
         FROM property_staff ps
         INNER JOIN property_owners po ON po.property_id = ps.property_id
         WHERE ps.staff_id = ? AND po.owner_id = ?`,
        [id, requesterId],
      );

      if (!rows.length) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์ลบพนักงานนี้" });
      }
    }

    // ลบความสัมพันธ์กับ property_staff
    await pool.execute("DELETE FROM property_staff WHERE staff_id = ?", [id]);

    // ลบความสัมพันธ์กับ property_owners (ถ้า staff เป็น owner ด้วย)
    await pool.execute("DELETE FROM property_owners WHERE owner_id = ?", [id]);

    // ลบผู้ใช้
    await pool.execute("DELETE FROM users WHERE id = ?", [id]);

    res.json({ message: "ลบพนักงานและข้อมูลที่เกี่ยวข้องสำเร็จ" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
