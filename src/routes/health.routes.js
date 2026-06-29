import { Router } from "express";
import { testDbConnection, pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();

const adminOnly = [requireAdminAuth, requireRole(["ADMIN"])];

function getSafeUptime() {
  return Math.round(process.uptime());
}

function getSafeTimestamp() {
  return new Date().toISOString();
}

//Solo confirma que la API está viva.
router.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    ok: true,
    service: "Andyfers Backend API",
    status: "running",
    uptime_seconds: getSafeUptime(),
    timestamp: getSafeTimestamp(),
  });
});

 //Solo confirma si la conexión a DB responde.
router.get("/db-health", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const connected = await testDbConnection();

    res.status(connected ? 200 : 503).json({
      ok: connected,
      status: connected ? "connected" : "disconnected",
      timestamp: getSafeTimestamp(),
    });
  } catch (error) {
    next(error);
  }
});

//Protegido. Informacion de la base de datos
router.get("/db-info", adminOnly, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const [tables] = await pool.query("SHOW TABLES");

    res.json({
      ok: true,
      database: process.env.DB_NAME || "andyfers",
      tables_count: tables.length,
      tables,
      timestamp: getSafeTimestamp(),
    });
  } catch (error) {
    next(error);
  }
});

//Protegio. Informacion de la base de datos desd admin
router.get("/admin/db-info", adminOnly, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const [tables] = await pool.query("SHOW TABLES");

    res.json({
      ok: true,
      database: process.env.DB_NAME || "andyfers",
      tables_count: tables.length,
      tables,
      timestamp: getSafeTimestamp(),
    });
  } catch (error) {
    next(error);
  }
});

export default router;