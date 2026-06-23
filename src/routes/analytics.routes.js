import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";
import { trackAnalyticsEvent } from "../services/analytics.service.js";

const router = Router();

const adminOnly = [requireAdminAuth, requireRole(["ADMIN"])];

function cleanString(value, maxLength = 320) {
  if (value === null || value === undefined) return "";

  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function parsePositiveInt(value, fallback = 50, max = 500) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return Math.min(parsed, max);
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function defaultDesde() {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

function defaultHasta() {
  return new Date().toISOString().slice(0, 10);
}

function getDateRange(query = {}) {
  const desde = isValidDate(query.desde) ? query.desde : defaultDesde();
  const hasta = isValidDate(query.hasta) ? query.hasta : defaultHasta();

  return { desde, hasta };
}

function dateWhere(alias = "ae", query = {}) {
  const { desde, hasta } = getDateRange(query);

  return {
    sql: `${alias}.fecha_evento >= ? AND ${alias}.fecha_evento < DATE_ADD(?, INTERVAL 1 DAY)`,
    params: [desde, hasta],
    desde,
    hasta,
  };
}

router.post("/analytics/event", async (req, res, next) => {
  try {
    const data = await trackAnalyticsEvent(req, req.body);

    res.status(201).json({
      ok: true,
      message: "Evento registrado correctamente.",
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/analytics/dashboard", adminOnly, async (req, res, next) => {
  try {
    const range = dateWhere("ae", req.query);
    const limit = parsePositiveInt(req.query.limit, 10, 50);

    const [kpisRows] = await pool.query(
      `
      SELECT
        COUNT(*) AS total_eventos,

        SUM(CASE
          WHEN ae.evento IN ('BUSQUEDA_CATALOGO', 'BUSQUEDA_IA')
            AND ae.resultado_estado = 'CON_RESULTADO'
          THEN 1 ELSE 0 END
        ) AS busquedas_con_resultado,

        SUM(CASE
          WHEN ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
            OR ae.resultado_estado = 'SIN_RESULTADO'
          THEN 1 ELSE 0 END
        ) AS busquedas_sin_resultado,

        SUM(CASE WHEN ae.evento = 'PRODUCTO_CONSULTADO' THEN 1 ELSE 0 END) AS productos_consultados,

        SUM(CASE WHEN ae.evento = 'PRODUCTO_AGREGADO_COTIZACION' THEN 1 ELSE 0 END) AS productos_agregados_cotizacion,

        SUM(CASE WHEN ae.evento = 'COTIZACION_GENERADA' THEN 1 ELSE 0 END) AS cotizaciones_generadas,

        SUM(CASE WHEN ae.evento = 'WHATSAPP_CLICK' THEN 1 ELSE 0 END) AS clicks_whatsapp,

        COUNT(DISTINCT ae.session_id) AS sesiones
      FROM analytics_eventos ae
      WHERE ${range.sql}
      `,
      range.params
    );

    const [sinResultadoRows] = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO') AS busqueda_normalizada,
        MIN(ae.busqueda_original) AS ejemplo_busqueda,
        COUNT(*) AS total_busquedas,
        COUNT(DISTINCT ae.session_id) AS sesiones,
        MAX(ae.fecha_evento) AS ultima_busqueda
      FROM analytics_eventos ae
      WHERE ${range.sql}
        AND (
          ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
          OR ae.resultado_estado = 'SIN_RESULTADO'
        )
      GROUP BY COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')
      ORDER BY total_busquedas DESC, ultima_busqueda DESC
      LIMIT ?
      `,
      [...range.params, limit]
    );

    const [productosConsultadosRows] = await pool.query(
      `
      SELECT
        ae.producto_id,
        ae.codigo_andyfers,
        ae.codigo_importacion,
        ae.categoria_nombre,
        ae.familia,
        COUNT(*) AS total_consultas,
        COUNT(DISTINCT ae.session_id) AS sesiones,
        MAX(ae.fecha_evento) AS ultima_consulta
      FROM analytics_eventos ae
      WHERE ${range.sql}
        AND ae.evento = 'PRODUCTO_CONSULTADO'
        AND ae.producto_id IS NOT NULL
      GROUP BY
        ae.producto_id,
        ae.codigo_andyfers,
        ae.codigo_importacion,
        ae.categoria_nombre,
        ae.familia
      ORDER BY total_consultas DESC, ultima_consulta DESC
      LIMIT ?
      `,
      [...range.params, limit]
    );

    const [productosCotizadosRows] = await pool.query(
      `
      SELECT
        ae.producto_id,
        ae.codigo_andyfers,
        ae.codigo_importacion,
        ae.categoria_nombre,
        ae.familia,
        COUNT(*) AS veces_agregado,
        COUNT(DISTINCT ae.cotizacion_id) AS cotizaciones,
        SUM(COALESCE(ae.cantidad, 0)) AS cantidad_total,
        MAX(ae.fecha_evento) AS ultima_vez
      FROM analytics_eventos ae
      WHERE ${range.sql}
        AND ae.evento = 'PRODUCTO_AGREGADO_COTIZACION'
        AND ae.producto_id IS NOT NULL
      GROUP BY
        ae.producto_id,
        ae.codigo_andyfers,
        ae.codigo_importacion,
        ae.categoria_nombre,
        ae.familia
      ORDER BY veces_agregado DESC, ultima_vez DESC
      LIMIT ?
      `,
      [...range.params, limit]
    );

    const [vehiculosRows] = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN_MARCA') AS marca_vehiculo,
        COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN_MODELO') AS modelo_vehiculo,
        COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN_ANIO') AS anio_vehiculo,
        COALESCE(NULLIF(ae.motor_vehiculo, ''), 'SIN_MOTOR') AS motor_vehiculo,
        COUNT(*) AS total_consultas,
        SUM(CASE WHEN ae.resultado_estado = 'SIN_RESULTADO' THEN 1 ELSE 0 END) AS consultas_sin_resultado,
        MAX(ae.fecha_evento) AS ultima_consulta
      FROM analytics_eventos ae
      WHERE ${range.sql}
        AND ae.evento IN (
          'BUSQUEDA_CATALOGO',
          'BUSQUEDA_CATALOGO_SIN_RESULTADO',
          'BUSQUEDA_IA',
          'BUSQUEDA_IA_SIN_RESULTADO'
        )
      GROUP BY
        COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN_MARCA'),
        COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN_MODELO'),
        COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN_ANIO'),
        COALESCE(NULLIF(ae.motor_vehiculo, ''), 'SIN_MOTOR')
      ORDER BY total_consultas DESC, consultas_sin_resultado DESC
      LIMIT ?
      `,
      [...range.params, limit]
    );

    res.json({
      ok: true,
      data: {
        rango: {
          desde: range.desde,
          hasta: range.hasta,
        },
        kpis: kpisRows[0] || {},
        busquedas_sin_resultado: sinResultadoRows,
        productos_mas_consultados: productosConsultadosRows,
        productos_mas_cotizados: productosCotizadosRows,
        consultas_vehiculo: vehiculosRows,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/admin/analytics/busquedas-sin-resultado",
  adminOnly,
  async (req, res, next) => {
    try {
      const range = dateWhere("ae", req.query);
      const limit = parsePositiveInt(req.query.limit, 100, 500);

      const [rows] = await pool.query(
        `
        SELECT
          COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO') AS busqueda_normalizada,
          MIN(ae.busqueda_original) AS ejemplo_busqueda,
          COUNT(*) AS total_busquedas,
          COUNT(DISTINCT ae.session_id) AS sesiones,
          MIN(ae.fecha_evento) AS primera_busqueda,
          MAX(ae.fecha_evento) AS ultima_busqueda,
          MAX(ae.marca_vehiculo) AS marca_vehiculo,
          MAX(ae.modelo_vehiculo) AS modelo_vehiculo,
          MAX(ae.anio_vehiculo) AS anio_vehiculo,
          MAX(ae.motor_vehiculo) AS motor_vehiculo
        FROM analytics_eventos ae
        WHERE ${range.sql}
          AND (
            ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
            OR ae.resultado_estado = 'SIN_RESULTADO'
          )
        GROUP BY COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')
        ORDER BY total_busquedas DESC, ultima_busqueda DESC
        LIMIT ?
        `,
        [...range.params, limit]
      );

      res.json({
        ok: true,
        data: rows,
        rango: {
          desde: range.desde,
          hasta: range.hasta,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/analytics/productos-consultados",
  adminOnly,
  async (req, res, next) => {
    try {
      const range = dateWhere("ae", req.query);
      const limit = parsePositiveInt(req.query.limit, 100, 500);

      const [rows] = await pool.query(
        `
        SELECT
          ae.producto_id,
          ae.codigo_andyfers,
          ae.codigo_importacion,
          ae.categoria_id,
          ae.categoria_nombre,
          ae.familia,
          COUNT(*) AS total_consultas,
          COUNT(DISTINCT ae.session_id) AS sesiones,
          MIN(ae.fecha_evento) AS primera_consulta,
          MAX(ae.fecha_evento) AS ultima_consulta
        FROM analytics_eventos ae
        WHERE ${range.sql}
          AND ae.evento = 'PRODUCTO_CONSULTADO'
          AND ae.producto_id IS NOT NULL
        GROUP BY
          ae.producto_id,
          ae.codigo_andyfers,
          ae.codigo_importacion,
          ae.categoria_id,
          ae.categoria_nombre,
          ae.familia
        ORDER BY total_consultas DESC, ultima_consulta DESC
        LIMIT ?
        `,
        [...range.params, limit]
      );

      res.json({
        ok: true,
        data: rows,
        rango: {
          desde: range.desde,
          hasta: range.hasta,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/analytics/productos-cotizados",
  adminOnly,
  async (req, res, next) => {
    try {
      const range = dateWhere("ae", req.query);
      const limit = parsePositiveInt(req.query.limit, 100, 500);

      const [rows] = await pool.query(
        `
        SELECT
          ae.producto_id,
          ae.codigo_andyfers,
          ae.codigo_importacion,
          ae.categoria_id,
          ae.categoria_nombre,
          ae.familia,
          COUNT(*) AS veces_agregado,
          COUNT(DISTINCT ae.cotizacion_id) AS cotizaciones,
          SUM(COALESCE(ae.cantidad, 0)) AS cantidad_total,
          MIN(ae.fecha_evento) AS primera_vez,
          MAX(ae.fecha_evento) AS ultima_vez
        FROM analytics_eventos ae
        WHERE ${range.sql}
          AND ae.evento = 'PRODUCTO_AGREGADO_COTIZACION'
          AND ae.producto_id IS NOT NULL
        GROUP BY
          ae.producto_id,
          ae.codigo_andyfers,
          ae.codigo_importacion,
          ae.categoria_id,
          ae.categoria_nombre,
          ae.familia
        ORDER BY veces_agregado DESC, ultima_vez DESC
        LIMIT ?
        `,
        [...range.params, limit]
      );

      res.json({
        ok: true,
        data: rows,
        rango: {
          desde: range.desde,
          hasta: range.hasta,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/admin/analytics/vehiculos", adminOnly, async (req, res, next) => {
  try {
    const range = dateWhere("ae", req.query);
    const limit = parsePositiveInt(req.query.limit, 100, 500);

    const [rows] = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN_MARCA') AS marca_vehiculo,
        COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN_MODELO') AS modelo_vehiculo,
        COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN_ANIO') AS anio_vehiculo,
        COALESCE(NULLIF(ae.motor_vehiculo, ''), 'SIN_MOTOR') AS motor_vehiculo,
        COUNT(*) AS total_consultas,
        SUM(CASE WHEN ae.resultado_estado = 'SIN_RESULTADO' THEN 1 ELSE 0 END) AS consultas_sin_resultado,
        SUM(CASE WHEN ae.resultado_estado = 'CON_RESULTADO' THEN 1 ELSE 0 END) AS consultas_con_resultado,
        COUNT(DISTINCT ae.session_id) AS sesiones,
        MIN(ae.fecha_evento) AS primera_consulta,
        MAX(ae.fecha_evento) AS ultima_consulta
      FROM analytics_eventos ae
      WHERE ${range.sql}
        AND ae.evento IN (
          'BUSQUEDA_CATALOGO',
          'BUSQUEDA_CATALOGO_SIN_RESULTADO',
          'BUSQUEDA_IA',
          'BUSQUEDA_IA_SIN_RESULTADO'
        )
      GROUP BY
        COALESCE(NULLIF(ae.marca_vehiculo, ''), 'SIN_MARCA'),
        COALESCE(NULLIF(ae.modelo_vehiculo, ''), 'SIN_MODELO'),
        COALESCE(NULLIF(ae.anio_vehiculo, ''), 'SIN_ANIO'),
        COALESCE(NULLIF(ae.motor_vehiculo, ''), 'SIN_MOTOR')
      ORDER BY total_consultas DESC, consultas_sin_resultado DESC
      LIMIT ?
      `,
      [...range.params, limit]
    );

    res.json({
      ok: true,
      data: rows,
      rango: {
        desde: range.desde,
        hasta: range.hasta,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/analytics/eventos", adminOnly, async (req, res, next) => {
  try {
    const range = dateWhere("ae", req.query);
    const limit = parsePositiveInt(req.query.limit, 100, 500);
    const evento = cleanString(req.query.evento, 80);
    const q = cleanString(req.query.q, 120);

    const clauses = [range.sql];
    const params = [...range.params];

    if (evento) {
      clauses.push("ae.evento = ?");
      params.push(evento);
    }

    if (q) {
      clauses.push(`
        (
          ae.busqueda_original LIKE ?
          OR ae.busqueda_normalizada LIKE ?
          OR ae.codigo_andyfers LIKE ?
          OR ae.codigo_importacion LIKE ?
          OR ae.familia LIKE ?
          OR ae.marca_vehiculo LIKE ?
          OR ae.modelo_vehiculo LIKE ?
        )
      `);

      const like = `%${q}%`;
      params.push(like, like, like, like, like, like, like);
    }

    const [rows] = await pool.query(
      `
      SELECT
        ae.*
      FROM analytics_eventos ae
      WHERE ${clauses.join(" AND ")}
      ORDER BY ae.fecha_evento DESC, ae.id DESC
      LIMIT ?
      `,
      [...params, limit]
    );

    res.json({
      ok: true,
      data: rows,
      rango: {
        desde: range.desde,
        hasta: range.hasta,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/admin/analytics/oportunidades/sync",
  adminOnly,
  async (req, res, next) => {
    try {
      const range = dateWhere("ae", req.query);

      const [result] = await pool.query(
        `
        INSERT INTO analytics_oportunidades_revision (
          tipo_oportunidad,
          referencia_key,
          titulo,
          descripcion,
          prioridad,
          estado,
          total_eventos,
          score,
          accion_sugerida,
          primer_evento,
          ultimo_evento
        )
        SELECT
          'BUSQUEDA_SIN_RESULTADO' AS tipo_oportunidad,
          grouped.busqueda_normalizada AS referencia_key,
          CONCAT('Búsqueda sin resultado: ', grouped.busqueda_normalizada) AS titulo,
          CONCAT(
            'La búsqueda "',
            grouped.busqueda_normalizada,
            '" aparece ',
            grouped.total_busquedas,
            ' veces sin resultado en el periodo.'
          ) AS descripcion,
          CASE
            WHEN grouped.total_busquedas >= 20 THEN 'ALTA'
            WHEN grouped.total_busquedas >= 8 THEN 'MEDIA'
            ELSE 'BAJA'
          END AS prioridad,
          'NUEVA' AS estado,
          grouped.total_busquedas AS total_eventos,
          grouped.total_busquedas * 10 AS score,
          'REVISAR_CATALOGO_O_COMPRAS' AS accion_sugerida,
          grouped.primera_busqueda AS primer_evento,
          grouped.ultima_busqueda AS ultimo_evento
        FROM (
          SELECT
            COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO') AS busqueda_normalizada,
            COUNT(*) AS total_busquedas,
            MIN(ae.fecha_evento) AS primera_busqueda,
            MAX(ae.fecha_evento) AS ultima_busqueda
          FROM analytics_eventos ae
          WHERE ${range.sql}
            AND (
              ae.evento IN ('BUSQUEDA_CATALOGO_SIN_RESULTADO', 'BUSQUEDA_IA_SIN_RESULTADO')
              OR ae.resultado_estado = 'SIN_RESULTADO'
            )
          GROUP BY COALESCE(NULLIF(ae.busqueda_normalizada, ''), 'SIN_TEXTO')
          HAVING total_busquedas >= 2
        ) grouped
        ON DUPLICATE KEY UPDATE
          descripcion = VALUES(descripcion),
          prioridad = VALUES(prioridad),
          total_eventos = VALUES(total_eventos),
          score = VALUES(score),
          accion_sugerida = VALUES(accion_sugerida),
          primer_evento = VALUES(primer_evento),
          ultimo_evento = VALUES(ultimo_evento),
          updated_at = CURRENT_TIMESTAMP
        `,
        range.params
      );

      res.json({
        ok: true,
        message: "Oportunidades sincronizadas correctamente.",
        data: {
          affected_rows: result.affectedRows,
        },
        rango: {
          desde: range.desde,
          hasta: range.hasta,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/analytics/oportunidades",
  adminOnly,
  async (req, res, next) => {
    try {
      const limit = parsePositiveInt(req.query.limit, 100, 500);
      const estado = cleanString(req.query.estado, 60);
      const tipo = cleanString(req.query.tipo, 80);

      const clauses = [];
      const params = [];

      if (estado) {
        clauses.push("estado = ?");
        params.push(estado);
      }

      if (tipo) {
        clauses.push("tipo_oportunidad = ?");
        params.push(tipo);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      const [rows] = await pool.query(
        `
        SELECT *
        FROM analytics_oportunidades_revision
        ${where}
        ORDER BY
          CASE prioridad
            WHEN 'ALTA' THEN 1
            WHEN 'MEDIA' THEN 2
            WHEN 'BAJA' THEN 3
            ELSE 4
          END,
          score DESC,
          ultimo_evento DESC
        LIMIT ?
        `,
        [...params, limit]
      );

      res.json({
        ok: true,
        data: rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/admin/analytics/oportunidades/:id",
  adminOnly,
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const allowedFields = [
        "estado",
        "prioridad",
        "accion_sugerida",
        "responsable",
        "nota",
      ];

      const updates = [];
      const params = [];

      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          updates.push(`${field} = ?`);
          params.push(cleanString(req.body[field], field === "nota" ? 4000 : 180));
        }
      }

      if (!updates.length) {
        return res.status(400).json({
          ok: false,
          error: "No hay campos para actualizar.",
        });
      }

      params.push(id);

      const [result] = await pool.query(
        `
        UPDATE analytics_oportunidades_revision
        SET ${updates.join(", ")}
        WHERE id = ?
        `,
        params
      );

      if (!result.affectedRows) {
        return res.status(404).json({
          ok: false,
          error: "Oportunidad no encontrada.",
        });
      }

      res.json({
        ok: true,
        message: "Oportunidad actualizada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;