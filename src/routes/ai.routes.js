import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth } from "../middleware/authAdmin.js";
import { searchCatalogWithAi } from "../services/aiCatalog.service.js";
import { trackAnalyticsEventSafe } from "../services/analytics.service.js";

const router = Router();

function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function pickIntentValue(intent, keys = []) {
  if (!intent || typeof intent !== "object") return null;

  for (const key of keys) {
    const value = intent[key] || intent.vehiculo?.[key];

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return null;
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

    const productos = Array.isArray(result.productos) ? result.productos : [];
    const totalRecomendados = Number(
      result.total_recomendados ?? productos.length ?? 0
    );
    const totalCandidatos = Number(
      result.total_candidatos ?? totalRecomendados ?? 0
    );
    const intent = result.intencion || result.intent || {};

    await trackAnalyticsEventSafe(req, {
      evento: totalRecomendados > 0 ? "BUSQUEDA_IA" : "BUSQUEDA_IA_SIN_RESULTADO",
      origen,
      session_id: result.session_id || sessionId || null,
      pregunta_usuario: question,
      busqueda_original: question,
      total_resultados: totalCandidatos,
      resultado_estado: totalRecomendados > 0 ? "CON_RESULTADO" : "SIN_RESULTADO",
      marca_vehiculo: pickIntentValue(intent, ["marca", "marca_auto", "marca_vehiculo"]),
      modelo_vehiculo: pickIntentValue(intent, ["modelo", "modelo_auto", "modelo_vehiculo"]),
      anio_vehiculo: pickIntentValue(intent, ["anio", "anio_auto", "anio_vehiculo"]),
      motor_vehiculo: pickIntentValue(intent, ["motor", "motor_auto", "motor_vehiculo"]),
      metadata: {
        servicio_ia: result.servicio_ia || null,
        total_candidatos: totalCandidatos,
        total_recomendados: totalRecomendados,
        requiere_mas_datos: Boolean(result.requiere_mas_datos),
        intencion: intent,
      },
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