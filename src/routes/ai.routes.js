import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth } from "../middleware/authAdmin.js";
import { searchCatalogWithAi } from "../services/aiCatalog.service.js";

const router = Router();

function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

router.post("/ia/buscar", async (req, res, next) => {
  try {
    const question = cleanString(
      req.body.pregunta || req.body.q || req.body.message
    );

    const origen = cleanString(req.body.origen) || "CHAT_PUBLICO";
    const sessionId = cleanString(req.body.session_id);

    const result = await searchCatalogWithAi({
      question,
      origen,
      sessionId,
    });

    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/ia/logs", requireAdminAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit || "50", 10), 100);

    const [rows] = await pool.query(
      `
      SELECT
        id,
        pregunta_usuario,
        servicio_ia,
        respuesta,
        total_candidatos,
        total_recomendados,
        origen,
        folio_cotizacion,
        created_at
      FROM ia_consultas_log
      ORDER BY created_at DESC, id DESC
      LIMIT ?
      `,
      [Number.isFinite(limit) && limit > 0 ? limit : 50]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

export default router;