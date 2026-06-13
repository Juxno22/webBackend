import { Router } from "express";
import { testDbConnection, pool } from "../config/db.js";

const router = Router();

router.get("/health", (req, res) => {
    res.json({
        ok: true,
        service: "Andyfers Backend API",
        status: "running",
        timestamp: new Date().toISOString(),
    });
});

router.get("/db-health", async (req, res, next) => {
    try {
        const connected = await testDbConnection();

        res.json({
            ok: connected,
            database: process.env.DB_NAME || "andyfers",
            status: connected ? "connected" : "disconnected",
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        next(error);
    }
});

router.get("/db-info", async (req, res, next) => {
    try {
        const [tables] = await pool.query("SHOW TABLES");

        res.json({
            ok: true,
            database: process.env.DB_NAME || "andyfers",
            tables_count: tables.length,
            tables,
        });
    } catch (error) {
        next(error);
    }
});

export default router;