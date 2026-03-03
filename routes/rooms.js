// routes/rooms.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { logActivity } = require("../helpers/activity");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// กำหนด storage สำหรับอัพโหลดไฟล์
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "../uploads/rooms");
    if (!fs.existsSync(uploadPath))
      fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });
// Get all rooms
router.get("/", authMiddleware(["admin"]), async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM rooms");
  res.json(rows);
});
// Get rooms ของ owner/staff ที่เกี่ยวข้องกับหอที่ตัวเองดูแล + สถานะห้องจริง
router.get("/my", authMiddleware(["owner", "staff"]), async (req, res) => {
  try {
    const { id: userId, role } = req.user; // ใช้ Destructuring เพื่อให้โค้ดกระชับขึ้น

    // กำหนด query SQL สำหรับดึงข้อมูลห้องพัก
    let baseQuery = `
      SELECT 
        r.id, 
        r.property_id, 
        p.name AS property_name,
        r.name,  
        r.description, 
        r.price_monthly, 
        r.price_term, 
        r.has_ac, 
        r.has_fan, 
        COALESCE(JSON_ARRAYAGG(ri.image_url), JSON_ARRAY()) AS images,
        (
          SELECT b.billing_cycle 
          FROM rents b 
          WHERE b.room_id = r.id 
          ORDER BY b.start_date DESC 
          LIMIT 1
        ) AS billing_cycle,
        (
          SELECT b.status 
          FROM rents b 
          WHERE b.room_id = r.id 
          ORDER BY b.end_date DESC 
          LIMIT 1
        ) AS latest_booking_status,
        (
          SELECT b.user_id 
          FROM rents b 
          WHERE b.room_id = r.id 
          AND b.status = 'confirmed'
          ORDER BY b.start_date DESC
          LIMIT 1
        ) AS current_tenant_id,
        (
          SELECT u.fullname 
          FROM users u 
          WHERE u.id = (
            SELECT b.user_id 
            FROM rents b 
            WHERE b.room_id = r.id 
            AND b.status = 'confirmed'
            ORDER BY b.start_date DESC
            LIMIT 1
          )
        ) AS current_tenant_name,
        (
          SELECT COUNT(*) 
          FROM maintenance_requests m 
          WHERE m.room_id = r.id 
          AND m.status IN ('pending', 'in_progress')
        ) AS active_maintenance
      FROM rooms r 
      JOIN properties p ON p.id = r.property_id
      LEFT JOIN room_images ri ON ri.room_id = r.id
    `;

    // เพิ่มเงื่อนไข JOIN และ WHERE ตามบทบาทของผู้ใช้ (เจ้าของหรือพนักงาน)
    if (role === "owner") {
      baseQuery += `
        JOIN property_owners po ON po.property_id = r.property_id
        WHERE po.owner_id = ?
      `;
    } else {
      baseQuery += `
        JOIN property_staff ps ON ps.property_id = r.property_id
        WHERE ps.staff_id = ?
      `;
    }

    baseQuery += `
      GROUP BY r.id 
      ORDER BY r.id
    `;

    // ดึงข้อมูลห้องพักจากฐานข้อมูล
    const [rows] = await pool.execute(baseQuery, [userId]);

    // ประมวลผลข้อมูลที่ได้จากฐานข้อมูล
    const processedRooms = rows.map((room) => {
      const { latest_booking_status, active_maintenance } = room;
      let status = "available";

      const isOccupied =
        latest_booking_status === "confirmed" ||
        latest_booking_status === "pending"; // ห้องมีคนอยู่หรือ pending
      const hasMaintenance = active_maintenance > 0;

      // กำหนดสถานะตาม priority ใหม่
      if (isOccupied && hasMaintenance) {
        status = "occupied_maintenance"; // ห้องมีคนอยู่และซ่อม
      } else if (isOccupied || hasMaintenance) {
        status = "occupied"; // ห้องมีคนอยู่ หรือ ห้อง maintenance → ถือว่าไม่ว่าง
      } else {
        status = "available"; // ห้องว่าง
      }

      // สร้าง object สำหรับข้อมูลผู้เช่า (ถ้ามี)
      const tenantInfo = room.current_tenant_id
        ? {
            tenantId: room.current_tenant_id,
            tenantName: room.current_tenant_name,
          }
        : null;

      return {
        ...room,
        status,
        tenantInfo,
      };
    });

    // ส่งข้อมูลที่ประมวลผลแล้วกลับไปให้ client
    res.json(processedRooms);
  } catch (err) {
    console.error("Error fetching rooms:", err);
    res
      .status(500)
      .json({ message: "An error occurred while fetching room data." }); // ปรับปรุงข้อความ error ให้ไม่เปิดเผยข้อมูลภายในมากเกินไป
  }
});
// Get rooms ของ owner/staff ที่เกี่ยวข้องกับหอที่ตัวเองดูแล + สถานะห้องจริง
router.get(
  "/rooms/my",
  authMiddleware(["owner", "staff"]),
  async (req, res) => {
    try {
      const { id: userId, role } = req.user;

      // SQL query สำหรับดึงข้อมูลห้องพัก พร้อม tenants ทุกคน
      let baseQuery = `
      SELECT 
        r.id, 
        r.property_id, 
        r.name, 
        r.description, 
        r.price_monthly, 
        r.price_term, 
        r.has_ac, 
        r.has_fan, 
        r.deposit, 
        COALESCE(JSON_ARRAYAGG(ri.image_url), JSON_ARRAY()) AS images,
        (
          SELECT b.billing_cycle 
          FROM rents b 
          WHERE b.room_id = r.id 
          ORDER BY b.start_date DESC 
          LIMIT 1
        ) AS billing_cycle,
        (
          SELECT b.status
          FROM rents b
          WHERE b.room_id = r.id
          ORDER BY b.start_date DESC
          LIMIT 1
        ) AS latest_booking_status,
        (
          SELECT COUNT(*) 
          FROM maintenance_requests m 
          WHERE m.room_id = r.id 
          AND m.status IN ('pending', 'in_progress')
        ) AS active_maintenance,
        (
          SELECT COALESCE(JSON_ARRAYAGG(
            JSON_OBJECT(
              'tenantId', u.id,
              'tenantName', u.fullname,
              'status', b.status,
              'startDate', b.start_date,
              'endDate', b.end_date
            )
          ), JSON_ARRAY())
          FROM rents b
          JOIN users u ON u.id = b.user_id
          WHERE b.room_id = r.id
        ) AS tenants
      FROM rooms r
      LEFT JOIN room_images ri ON ri.room_id = r.id
    `;

      // เงื่อนไขสำหรับ owner/staff
      if (role === "owner") {
        baseQuery += `
        JOIN property_owners po ON po.property_id = r.property_id
        WHERE po.owner_id = ?
      `;
      } else {
        baseQuery += `
        JOIN property_staff ps ON ps.property_id = r.property_id
        WHERE ps.staff_id = ?
      `;
      }

      baseQuery += `
      GROUP BY r.id
      ORDER BY r.id
    `;

      // ดึงข้อมูล
      const [rows] = await pool.execute(baseQuery, [userId]);

      // ประมวลผลข้อมูล
      const processedRooms = rows.map((room) => {
        let images = [];
        try {
          images =
            typeof room.images === "string"
              ? JSON.parse(room.images)
              : room.images;
          images = images.filter((img) => img && img.trim() !== "");
        } catch (e) {
          images = [];
        }

        let tenants = [];
        try {
          tenants =
            typeof room.tenants === "string"
              ? JSON.parse(room.tenants)
              : room.tenants;
        } catch (e) {
          tenants = [];
        }

        const { latest_booking_status, active_maintenance } = room;
        let status = "available";
        if (active_maintenance > 0) status = "maintenance";
        if (latest_booking_status === "confirmed") {
          status = active_maintenance > 0 ? "occupied_maintenance" : "occupied";
        } else if (latest_booking_status === "pending") {
          status = active_maintenance > 0 ? "pending_maintenance" : "pending";
        }

        return {
          ...room,
          images,
          tenants,
          status,
        };
      });

      res.json(processedRooms);
    } catch (err) {
      console.error("Error fetching rooms:", err);
      res
        .status(500)
        .json({ message: "An error occurred while fetching room data." });
    }
  },
);
// Get room by id
router.get(
  "/:id",
  authMiddleware(["admin", "owner", "staff", "tenant"]),
  async (req, res) => {
    const [rows] = await pool.execute("SELECT * FROM rooms WHERE id=?", [
      req.params.id,
    ]);
    if (!rows.length)
      return res.status(404).json({ message: "Room not found" });
    res.json(rows[0]);
  },
);
// post room (admin/owner/staff)
router.post(
  "/",
  authMiddleware(["admin", "owner", "staff"]),
  upload.array("imageFiles"), // รับหลายไฟล์
  async (req, res) => {
    const {
      property_id,
      name,
      price_monthly,
      price_term,
      has_ac,
      has_fan,
      deposit,
      description,
      images, // URL string จาก frontend
    } = req.body;

    if (!name) return res.status(400).json({ message: "กรุณาระบุชื่อห้อง" });

    try {
      const [result] = await pool.execute(
        "INSERT INTO rooms (property_id, name, price_monthly, price_term, has_ac, has_fan, deposit, description) VALUES (?,?,?,?,?,?,?,?)",
        [
          property_id ?? null,
          name,
          price_monthly === "" ? null : price_monthly,
          price_term === "" ? null : price_term,
          has_ac ?? 0,
          has_fan ?? 0,
          deposit === "" ? null : deposit,
          description === "" ? null : description,
        ],
      );
      const roomId = result.insertId;

      // 1️⃣ บันทึกรูปจาก URL
      if (images) {
        const imageArray = images
          .split(",")
          .map((img) => img.trim())
          .filter(Boolean);
        for (let imgUrl of imageArray) {
          await pool.execute(
            "INSERT INTO room_images (room_id, image_url) VALUES (?,?)",
            [roomId, imgUrl],
          );
        }
      }

      // 2️⃣ บันทึกรูปจากไฟล์ที่อัพโหลด
      if (req.files && req.files.length) {
        for (let file of req.files) {
          const filePath = `/uploads/rooms/${file.filename}`;
          await pool.execute(
            "INSERT INTO room_images (room_id, image_url) VALUES (?,?)",
            [roomId, filePath],
          );
        }
      }

      await logActivity(
        req.user.id,
        "create_room",
        "room",
        roomId,
        `${req.user.username || "ไม่ทราบผู้ใช้"} สร้างห้อง ${name}`,
      );

      res.json({ message: "Room created", id: roomId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  },
);
// Update room (/owner/staff)
router.put(
  "/:id",
  authMiddleware(["owner", "staff"]),
  upload.array("imageFiles"),
  async (req, res) => {
    const {
      name,
      price_monthly,
      price_term,
      has_ac,
      has_fan,
      description,
      deposit,
      existingImages: existingImagesBody, // 👈 รับจาก frontend
    } = req.body;

    const roomId = req.params.id;

    try {
      // 1️⃣ อัปเดตข้อมูลห้อง
      await pool.execute(
        `UPDATE rooms 
         SET name=?, price_monthly=?, price_term=?, 
             has_ac=?, has_fan=?, deposit=?, description=? 
         WHERE id=?`,
        [
          name,
          price_monthly === "" ? null : price_monthly,
          price_term === "" ? null : price_term,
          has_ac ?? 0,
          has_fan ?? 0,
          deposit === "" ? null : deposit,
          description === "" ? null : description,
          roomId,
        ],
      );

      let newImages = [];

      // 2️⃣ รูปเดิมที่ยังเหลือ (จาก frontend)
      if (existingImagesBody) {
        try {
          const parsed = JSON.parse(existingImagesBody);
          if (Array.isArray(parsed)) {
            newImages.push(...parsed);
          }
        } catch (e) {
          console.error("existingImages parse error:", e);
        }
      }

      // 3️⃣ ไฟล์ใหม่ที่ upload
      if (req.files && req.files.length) {
        newImages.push(
          ...req.files.map((file) => `/uploads/rooms/${file.filename}`),
        );
      }

      // 4️⃣ ดึงรูปเดิมทั้งหมดจาก DB
      const [existingImagesDB] = await pool.execute(
        "SELECT image_url FROM room_images WHERE room_id=?",
        [roomId],
      );

      const existingSet = new Set(existingImagesDB.map((row) => row.image_url));
      const newSet = new Set(newImages);

      // 5️⃣ ลบรูปที่ถูกลบออก
      for (let img of existingImagesDB) {
        if (!newSet.has(img.image_url)) {
          await pool.execute(
            "DELETE FROM room_images WHERE room_id=? AND image_url=?",
            [roomId, img.image_url],
          );

          // ลบไฟล์จริง
          const filePath = path.join(__dirname, "..", img.image_url);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      }

      // 6️⃣ เพิ่มรูปใหม่ที่ยังไม่มี
      for (let imgUrl of newImages) {
        if (!existingSet.has(imgUrl)) {
          await pool.execute(
            "INSERT INTO room_images (room_id, image_url) VALUES (?,?)",
            [roomId, imgUrl],
          );
        }
      }

      await logActivity(
        req.user.id,
        "update_room",
        "room",
        roomId,
        `${req.user.username || "ไม่ทราบผู้ใช้"} อัปเดตห้อง ${name}`,
      );

      res.json({ message: "Room updated" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  },
);
// Delete room (admin/owner/staff)
router.delete(
  "/:id",
  authMiddleware(["admin", "owner", "staff"]),
  async (req, res) => {
    const roomId = req.params.id;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // เช็คว่าห้องมีอยู่ไหม
      const [roomRows] = await connection.execute(
        "SELECT name FROM rooms WHERE id=?",
        [roomId],
      );

      if (roomRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ message: "Room not found" });
      }

      const roomName = roomRows[0].name;

      // ✅ เช็คว่ามี booking ที่ยัง active ไหม
      const [bookingRows] = await connection.execute(
        `SELECT id FROM rents 
       WHERE room_id = ? 
       AND status IN ('pending','confirmed')`,
        [roomId],
      );

      if (bookingRows.length > 0) {
        await connection.rollback();
        return res.status(400).json({
          message: "ไม่สามารถลบห้องได้ เนื่องจากมีการเช่าอยู่",
        });
      }

      // ลบห้อง
      await connection.execute("DELETE FROM rooms WHERE id=?", [roomId]);

      // log activity
      await logActivity(
        req.user.id,
        "delete_room",
        "room",
        roomId,
        `${req.user.username || "ไม่ทราบผู้ใช้"} ลบห้อง ${roomName}`,
      );

      await connection.commit();

      res.json({ message: "ลบข้อมูลห้องพักสำเร็จ" });
    } catch (err) {
      await connection.rollback();
      console.error(err);
      res.status(500).json({ message: err.message });
    } finally {
      connection.release();
    }
  },
);

module.exports = router;
