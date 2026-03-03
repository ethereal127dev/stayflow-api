// routes/properties.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { logActivity } = require("../helpers/activity");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// สร้าง storage สำหรับ multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "../uploads/properties");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${Date.now()}${ext}`;
    cb(null, filename);
  },
});

const upload = multer({ storage });

// Get all properties (Guest/Anyone can view) + computed rating + available rooms
router.get("/", async (req, res) => {
  try {
    // ดึง properties หลัก
    const [properties] = await pool.execute(`SELECT * FROM properties`);

    const result = [];

    for (const p of properties) {
      // ดึงห้องทั้งหมดใน property
      const [rooms] = await pool.execute(
        "SELECT id, price_monthly, price_term FROM rooms WHERE property_id = ?",
        [p.id],
      );

      const total_rooms = rooms.length;
      const min_price_monthly =
        rooms.length > 0
          ? Math.min(...rooms.map((r) => parseFloat(r.price_monthly)))
          : null;
      const min_price_term =
        rooms.length > 0
          ? Math.min(...rooms.map((r) => parseFloat(r.price_term)))
          : null;

      // ดึง rating เฉลี่ย
      const [ratingRows] = await pool.execute(
        "SELECT AVG(rating) AS avg_rating FROM reviews WHERE property_id = ?",
        [p.id],
      );
      const rating =
        ratingRows[0].avg_rating !== null
          ? parseFloat(ratingRows[0].avg_rating).toFixed(1)
          : null;

      // ดึงห้องที่ถูกจองแล้ว (ทั้ง pending และ confirmed)
      const [bookedRooms] = await pool.execute(
        `SELECT DISTINCT room_id 
   FROM rents 
   WHERE status IN ('confirmed') 
     AND room_id IN (SELECT id FROM rooms WHERE property_id = ?)`,
        [p.id],
      );

      const bookedRoomIds = bookedRooms.map((b) => b.room_id);

      // จำนวนห้องว่าง
      const available_rooms = rooms.filter(
        (r) => !bookedRoomIds.includes(r.id),
      ).length;

      result.push({
        ...p,
        total_rooms,
        available_rooms,
        min_price_monthly,
        min_price_term,
        rating,
      });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Admin: get all properties with owner(s) username
router.get("/admin", authMiddleware(["admin"]), async (req, res) => {
  try {
    // ดึง property + owner(s) ด้วย JSON_ARRAYAGG
    const [rows] = await pool.execute(`
      SELECT 
        p.*,
        COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
          'id', u.id,
          'username', u.username,
          'fullname', u.fullname,
          'email', u.email
        )), JSON_ARRAY()) AS owners,
        (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id) AS total_rooms
      FROM properties p
      LEFT JOIN property_owners po ON po.property_id = p.id
      LEFT JOIN users u ON u.id = po.owner_id
      GROUP BY p.id
      ORDER BY p.id DESC
    `);

    // แปลง owners จาก string JSON เป็น array จริง
    const result = rows.map((r) => ({
      ...r,
      owners: typeof r.owners === "string" ? JSON.parse(r.owners) : r.owners,
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// Get properties of current owner/staff
router.get("/my", authMiddleware(["owner", "staff"]), async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;

    let rows;

    if (role === "owner") {
      [rows] = await pool.execute(
        `
        SELECT p.*,
          (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id) AS roomsCount,
          (SELECT COUNT(DISTINCT b.user_id) 
           FROM rents b 
           JOIN rooms r2 ON b.room_id = r2.id 
           WHERE r2.property_id = p.id AND b.status = 'confirmed') AS tenantsCount,
          (SELECT IFNULL(ROUND(AVG(r.rating),1),0) 
           FROM reviews r 
           WHERE r.property_id = p.id) AS avgRating,
          (SELECT rate FROM property_utilities pu WHERE pu.property_id = p.id AND pu.type='electric' LIMIT 1) AS priceElectric,
          (SELECT rate FROM property_utilities pu WHERE pu.property_id = p.id AND pu.type='water' LIMIT 1) AS priceWater
        FROM properties p
        JOIN property_owners po ON po.property_id = p.id
        WHERE po.owner_id = ?
        ORDER BY p.id
        `,
        [userId],
      );
    } else if (role === "staff") {
      [rows] = await pool.execute(
        `
        SELECT p.*,
          (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id) AS roomsCount,
          (SELECT COUNT(DISTINCT b.user_id) 
           FROM rents b 
           JOIN rooms r2 ON b.room_id = r2.id 
           WHERE r2.property_id = p.id AND b.status = 'confirmed') AS tenantsCount,
          (SELECT IFNULL(ROUND(AVG(r.rating),1),0) 
           FROM reviews r 
           WHERE r.property_id = p.id) AS avgRating,
          (SELECT rate FROM property_utilities pu WHERE pu.property_id = p.id AND pu.type='electric' LIMIT 1) AS priceElectric,
          (SELECT rate FROM property_utilities pu WHERE pu.property_id = p.id AND pu.type='water' LIMIT 1) AS priceWater
        FROM properties p
        JOIN property_staff ps ON ps.property_id = p.id
        WHERE ps.staff_id = ?
        ORDER BY p.id
        `,
        [userId],
      );
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/properties/tenant - ดึงหอ/อสังหาฯ ของ tenant
router.get(
  "/tenant/properties",
  authMiddleware(["tenant"]),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const [rows] = await pool.execute(
        `
      SELECT DISTINCT 
        p.id AS property_id,
        p.name AS property_name,
        p.address,
        p.description,
        p.image,
        (
          SELECT ROUND(AVG(rating),1) 
          FROM reviews 
          WHERE property_id = p.id
        ) AS rating
      FROM rents b
      JOIN rooms r ON r.id = b.room_id
      JOIN properties p ON p.id = r.property_id
      WHERE b.user_id = ? AND b.status = 'confirmed'
      `,
        [userId],
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  },
);
// GET /api/properties/reviews/options - ดึงทุกหอ สำหรับ dropdown รีวิว
router.get("/reviews/options", authMiddleware(["tenant"]), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `
      SELECT 
        p.id,
        p.name,
        p.address,
        p.description,
        p.image,
        (
          SELECT ROUND(AVG(rating),1) 
          FROM reviews 
          WHERE property_id = p.id
        ) AS rating
      FROM properties p
      ORDER BY p.name ASC
      `,
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});
// เช็คชื่อหอซ้ำ (สำหรับ create/edit)
router.get("/check-name", async (req, res) => {
  const { name, id } = req.query;

  let query = `SELECT id FROM properties WHERE name = ?`;
  let params = [name];

  if (id) {
    query += ` AND id != ?`;
    params.push(id);
  }

  const [rows] = await pool.query(query, params);

  res.json({ exists: rows.length > 0 });
});
// Get single property with all related data
router.get("/:id", async (req, res) => {
  try {
    const propertyId = req.params.id;

    // ข้อมูล property + owner(s)
    const [propRows] = await pool.execute(
      `SELECT p.* FROM properties p WHERE p.id = ?`,
      [propertyId],
    );

    if (!propRows.length) {
      return res.status(404).json({ message: "Property not found" });
    }

    const property = propRows[0];

    // ดึง owner(s) ของ property
    const [ownerRows] = await pool.execute(
      `SELECT u.id, u.username, u.fullname, u.phone, u.line, u.email
       FROM property_owners po
       JOIN users u ON po.owner_id = u.id
       WHERE po.property_id = ?`,
      [propertyId],
    );
    property.owners = ownerRows;

    // ดึงค่าไฟ/ค่าน้ำ
    const [utilityRows] = await pool.execute(
      `SELECT type, rate 
   FROM property_utilities 
   WHERE property_id = ?`,
      [propertyId],
    );

    // map ให้เข้า property.price_electric / property.price_water
    property.price_electric = null;
    property.price_water = null;

    utilityRows.forEach((u) => {
      if (u.type === "electric") property.price_electric = u.rate;
      else if (u.type === "water") property.price_water = u.rate;
    });

    // ข้อมูลห้องใน property นี้ + รูปภาพ
    const [roomRows] = await pool.execute(
      `SELECT r.*, 
              COALESCE(JSON_ARRAYAGG(ri.image_url), JSON_ARRAY()) AS images
       FROM rooms r
       LEFT JOIN room_images ri ON ri.room_id = r.id
       WHERE r.property_id = ?
       GROUP BY r.id`,
      [propertyId],
    );

    // ดึง booking ที่ยืนยันแล้วหรือรอดำเนินการของห้องทั้งหมด
    const [bookedRooms] = await pool.execute(
      `SELECT DISTINCT b.room_id
      FROM rents b
      JOIN rooms r ON b.room_id = r.id
      WHERE r.property_id = ? AND b.status IN ('confirmed')`,
      [propertyId],
    );
    const bookedRoomIds = bookedRooms.map((br) => br.room_id);

    // ดึง maintenance requests ที่ยังไม่เสร็จ
    const [maintenanceRows] = await pool.execute(
      `SELECT * FROM maintenance_requests 
       WHERE room_id IN (?) AND status != 'completed'`,
      [roomRows.map((r) => r.id)],
    );

    // แปลง images และสร้าง field status
    property.rooms = roomRows.map((room) => {
      let images = [];
      if (room.images) {
        try {
          images =
            typeof room.images === "string"
              ? JSON.parse(room.images)
              : room.images;
        } catch (e) {
          images = [];
        }
      }

      // กำหนดสถานะ
      const isMaintenance = maintenanceRows.some((m) => m.room_id === room.id);
      const isBooked = bookedRoomIds.includes(room.id);

      let status = "available";
      if (isMaintenance) status = "maintenance";
      else if (isBooked) status = "booked";

      return { ...room, images: images.filter((img) => img), status };
    });

    // สิ่งอำนวยความสะดวก
    const [facilityRows] = await pool.execute(
      "SELECT * FROM property_facilities WHERE property_id=?",
      [propertyId],
    );
    property.facilities = facilityRows;

    // รีวิว
    const [reviewRows] = await pool.execute(
      `SELECT r.*, u.fullname AS user_name
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       WHERE r.property_id = ?
       ORDER BY r.created_at DESC`,
      [propertyId],
    );
    property.reviews = reviewRows;

    // rating เฉลี่ย
    property.rating = reviewRows.length
      ? (
          reviewRows.reduce((sum, r) => sum + r.rating, 0) / reviewRows.length
        ).toFixed(1)
      : null;

    // จำนวนห้อง
    property.total_rooms = roomRows.length;

    // จำนวนห้องว่าง
    property.available_rooms = property.rooms.filter(
      (room) => room.status === "available",
    ).length;

    // ราคาเริ่มต้น
    const monthlyPrices = roomRows
      .map((r) => r.price_monthly)
      .filter((p) => p !== null);
    const termPrices = roomRows
      .map((r) => r.price_term)
      .filter((p) => p !== null);
    property.min_price_monthly = monthlyPrices.length
      ? Math.min(...monthlyPrices)
      : null;
    property.min_price_term = termPrices.length
      ? Math.min(...termPrices)
      : null;

    // ดึงเฟอร์นิเจอร์ของแต่ละห้อง
    const [furnitureRows] = await pool.execute(
      `SELECT rf.*, r.id AS room_id 
      FROM room_furnitures rf
      JOIN rooms r ON rf.room_id = r.id
      WHERE r.property_id = ?`,
      [propertyId],
    );
    // ผูกเฟอร์นิเจอร์เข้ากับแต่ละห้อง
    property.rooms = property.rooms.map((room) => {
      const furnitures = furnitureRows.filter((f) => f.room_id === room.id);
      return { ...room, furnitures };
    });

    res.json(property);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get rooms by property admin (รวมรูปภาพและสถานะจาก booking)
router.get("/:id/rooms", authMiddleware(["admin"]), async (req, res) => {
  const { id } = req.params;
  try {
    const [rooms] = await pool.execute(
      `
      SELECT 
        r.id,
        r.property_id,
        r.name,
        r.code,
        r.description,
        r.price_monthly,
        r.price_term,
        r.has_ac,
        r.has_fan,
        COALESCE(JSON_ARRAYAGG(ri.image_url), JSON_ARRAY()) AS images,
        (
          SELECT b.status 
          FROM rents b 
          WHERE b.room_id = r.id 
          AND b.status = 'confirmed'
          ORDER BY b.start_date DESC 
          LIMIT 1
        ) AS booking_status,
        (
          SELECT b.billing_cycle
          FROM rents b
          WHERE b.room_id = r.id
          ORDER BY b.start_date DESC
          LIMIT 1
        ) AS billing_cycle,
        (
          SELECT COUNT(*) 
          FROM rents b 
          WHERE b.room_id = r.id 
          AND b.status = 'pending'
        ) AS pending_bookings_count
      FROM rooms r
      LEFT JOIN room_images ri ON ri.room_id = r.id
      WHERE r.property_id = ?
      GROUP BY r.id
      ORDER BY r.id ASC
      `,
      [id],
    );

    const result = rooms.map((r) => {
      let roomStatus = "available";

      if (r.booking_status === "confirmed") {
        roomStatus = "occupied";
      } else if (r.pending_bookings_count > 0) {
        roomStatus = "pending";
      }

      return {
        ...r,
        images: typeof r.images === "string" ? JSON.parse(r.images) : r.images,
        status: roomStatus,
        booking_status: r.booking_status,
        billing_cycle: r.billing_cycle,
        pending_bookings_count: r.pending_bookings_count,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});
// Create property by admin
router.post(
  "/",
  authMiddleware(["admin"]),
  upload.single("imageFile"), // รับไฟล์ชื่อ imageFile
  async (req, res) => {
    try {
      let { name, address, description, image, owner_ids = [] } = req.body;

      // ถ้ามีไฟล์อัปโหลด ให้ใช้ path ของไฟล์แทน
      if (req.file) {
        image = `/uploads/properties/${req.file.filename}`;
      }

      // 1. สร้าง property
      const [result] = await pool.execute(
        "INSERT INTO properties (name, address, description, image) VALUES (?,?,?,?)",
        [name, address, description, image],
      );

      const propertyId = result.insertId;

      // 2. ผูก owner_ids
      for (let ownerId of owner_ids) {
        const [users] = await pool.execute(
          "SELECT id FROM users WHERE id = ? AND role = 'owner'",
          [ownerId],
        );
        if (users.length > 0) {
          await pool.execute(
            "INSERT INTO property_owners (property_id, owner_id) VALUES (?,?)",
            [propertyId, ownerId],
          );
        }
      }

      await logActivity(
        req.user.id,
        "create_property",
        "property",
        propertyId,
        `${
          req.user.username || "ไม่ทราบผู้ใช้"
        } สร้างอสังหาริมทรัพย์ใหม่ ${name}`,
      );

      res.json({ message: "Property created", id: propertyId });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);
// edit by admin
router.put(
  "/:id",
  authMiddleware(["admin"]),
  upload.single("imageFile"),
  async (req, res) => {
    try {
      const propertyId = req.params.id;
      let { name, address, description, image } = req.body;
      let owner_ids = [];

      // parse owner_ids จาก JSON string → array
      if (req.body.owner_ids) {
        try {
          owner_ids = JSON.parse(req.body.owner_ids);
        } catch (e) {
          owner_ids = [];
        }
      }

      if (req.file) {
        image = `/uploads/properties/${req.file.filename}`;
      }

      // update property
      await pool.execute(
        "UPDATE properties SET name=?, address=?, description=?, image=? WHERE id=?",
        [name, address, description, image, propertyId],
      );

      // เคลียร์เจ้าของเก่า
      await pool.execute("DELETE FROM property_owners WHERE property_id=?", [
        propertyId,
      ]);

      // ใส่เจ้าของใหม่
      for (let ownerId of owner_ids) {
        const [users] = await pool.execute(
          "SELECT id FROM users WHERE id = ? AND role = 'owner'",
          [ownerId],
        );
        if (users.length > 0) {
          await pool.execute(
            "INSERT INTO property_owners (property_id, owner_id) VALUES (?,?)",
            [propertyId, ownerId],
          );
        }
      }

      await logActivity(
        req.user.id,
        "update_property",
        "property",
        propertyId,
        `${req.user.username || "ไม่ทราบผู้ใช้"} อัปเดตอสังหาริมทรัพย์ ${name}`,
      );

      res.json({ message: "Property updated" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);
// เพิ่มอสังหาริมทรัพย์ + ค่าไฟ/ค่าน้ำ 
router.post(
  "/add",
  authMiddleware(["owner"]),
  upload.single("imageFile"),
  async (req, res) => {
    const { name, address, image, description, electric_rate, water_rate } =
      req.body;
    const { id: userId, username } = req.user;

    let imagePath = image || null;
    if (req.file) {
      imagePath = `/uploads/properties/${req.file.filename}`;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1️⃣ insert property
      const [propertyResult] = await conn.execute(
        `INSERT INTO properties (name, address, image, description)
         VALUES (?, ?, ?, ?)`,
        [name, address, imagePath, description]
      );

      const propertyId = propertyResult.insertId;

      // 2️⃣ insert utilities
      await conn.execute(
        `INSERT INTO property_utilities (property_id, type, rate) VALUES 
         (?, 'electric', ?), 
         (?, 'water', ?)`,
        [propertyId, electric_rate, propertyId, water_rate]
      );

      // 3️⃣ insert owner relation
      await conn.execute(
        `INSERT INTO property_owners (property_id, owner_id)
         VALUES (?, ?)`,
        [propertyId, userId]
      );

      await conn.commit();

      await logActivity(
        userId,
        "add_property",
        "property",
        propertyId,
        `${username || "ไม่ทราบผู้ใช้"} เพิ่มอสังหาริมทรัพย์ ${name}`
      );

      res.json({
        success: true,
        message: "เพิ่มอสังหาริมทรัพย์และผูกเจ้าของสำเร็จ",
      });

    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
    } finally {
      conn.release();
    }
  }
);
// แก้ไขอสังหาริมทรัพย์ + ค่าไฟ/ค่าน้ำ
router.put(
  "/edit/:id",
  authMiddleware(["owner"]),
  upload.single("imageFile"),
  async (req, res) => {
    const propertyId = req.params.id;
    const { name, address, image, description, electric_rate, water_rate } =
      req.body;
    const { id: userId } = req.user;

    let imagePath = image || null;
    if (req.file) {
      imagePath = `/uploads/properties/${req.file.filename}`;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [checkOwner] = await conn.execute(
        `SELECT 1 FROM property_owners WHERE property_id=? AND owner_id=?`,
        [propertyId, userId],
      );
      if (!checkOwner.length) {
        await conn.rollback();
        return res.status(403).json({ success: false, message: "Forbidden" });
      }

      await conn.execute(
        `UPDATE properties 
       SET name=?, address=?, image=?, description=? 
       WHERE id=?`,
        [name, address, imagePath, description, propertyId],
      );

      await conn.execute(
        `UPDATE property_utilities SET rate=? WHERE property_id=? AND type='electric'`,
        [electric_rate, propertyId],
      );
      await conn.execute(
        `UPDATE property_utilities SET rate=? WHERE property_id=? AND type='water'`,
        [water_rate, propertyId],
      );

      await conn.commit();

      await logActivity(
        userId,
        "edit_property",
        "property",
        propertyId,
        `${req.user.username || "ไม่ทราบผู้ใช้"} แก้ไขอสังหาริมทรัพย์ ${name}`,
      );
      res.json({ success: true, message: "แก้ไขอสังหาริมทรัพย์สำเร็จ" });
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
    } finally {
      conn.release();
    }
  },
);

// Delete property และข้อมูลที่เกี่ยวข้องทั้งหมด (admin/owner)
router.delete("/:id", authMiddleware(["admin", "owner"]), async (req, res) => {
  const propertyId = req.params.id;

  try {
    // 1️⃣ เช็ค property
    const [[property]] = await pool.execute(
      "SELECT id, name FROM properties WHERE id=?",
      [propertyId],
    );
    if (!property) {
      return res.status(404).json({ message: "ไม่พบอสังหาริมทรัพย์" });
    }

    // 2️⃣ เช็คความเกี่ยวข้องทั้งหมด
    const checks = {};

    // ✅ เช็ค owners เฉพาะกรณีเป็น admin
    if (req.user.role === "admin") {
      const [[ownerCount]] = await pool.execute(
        "SELECT COUNT(*) AS count FROM property_owners WHERE property_id=?",
        [propertyId],
      );
      if (ownerCount.count > 0) checks.owners = ownerCount.count;
    }

    const [[staffCount]] = await pool.execute(
      "SELECT COUNT(*) AS count FROM property_staff WHERE property_id=?",
      [propertyId],
    );
    if (staffCount.count > 0) checks.staff = staffCount.count;

    const [[roomCount]] = await pool.execute(
      "SELECT COUNT(*) AS count FROM rooms WHERE property_id=?",
      [propertyId],
    );
    if (roomCount.count > 0) checks.rooms = roomCount.count;

    const [[bookingCount]] = await pool.execute(
      `
  SELECT COUNT(*) AS count
  FROM rents b
  JOIN rooms r ON b.room_id = r.id
  WHERE r.property_id = ?
    AND b.status IN ('pending', 'confirmed')
  `,
      [propertyId],
    );
    if (bookingCount.count > 0) checks.bookings = bookingCount.count;

    // ❌ ถ้ามีอะไรค้างอยู่ → ไม่ให้ลบ
    if (Object.keys(checks).length > 0) {
      return res.status(400).json({
        message: "ไม่สามารถลบอสังหาริมทรัพย์ได้",
        reasons: checks,
      });
    }

    // 3️⃣ ลบข้อมูลที่ไม่มีผลกระทบ
    const tablesToDelete = [
      "property_utilities",
      "property_facilities",
      "reviews",
      "packages",
    ];

    for (const table of tablesToDelete) {
      await pool.execute(`DELETE FROM ${table} WHERE property_id=?`, [
        propertyId,
      ]);
    }

    // 4️⃣ ลบ property
    await pool.execute("DELETE FROM properties WHERE id=?", [propertyId]);

    // 5️⃣ log
    await logActivity(
      req.user.id,
      "delete_property",
      "property",
      propertyId,
      `${req.user.username} ลบอสังหาริมทรัพย์ ${property.name}`,
    );

    res.json({ message: "ลบอสังหาริมทรัพย์สำเร็จ" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
