import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";
import { normalizePartNumber, normalizeText } from "../utils/normalize.js";

const router = Router();

const ESTADOS_VALIDOS = [
  "NUEVA",
  "EN_REVISION",
  "CONTACTADO",
  "COTIZADO",
  "EN_PROCESO",
  "CERRADO",
  "CANCELADO",
  "REQUIERE_DATOS",
];

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const clean = String(value).trim();

  return clean === "" ? null : clean;
}

function parsePositiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) return fallback;

  return parsed;
}

function buildPagination(query) {
  const page = parsePositiveInt(query.page, 1);
  const limit = Math.min(parsePositiveInt(query.limit, 20), 80);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

router.post("/admin/login", async (req, res, next) => {
  try {
    const correo = cleanString(req.body.correo);
    const password = cleanString(req.body.password);

    if (!correo || !password) {
      return res.status(400).json({
        ok: false,
        error: "Correo y contraseña son obligatorios.",
      });
    }

    const [rows] = await pool.query(
      `
      SELECT
        id,
        nombre,
        correo,
        password_hash,
        rol,
        activo
      FROM usuarios_admin
      WHERE correo = ?
      LIMIT 1
      `,
      [correo]
    );

    const user = rows?.[0];

    if (!user || Number(user.activo) !== 1) {
      return res.status(401).json({
        ok: false,
        error: "Credenciales inválidas.",
      });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);

    if (!passwordOk) {
      return res.status(401).json({
        ok: false,
        error: "Credenciales inválidas.",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        correo: user.correo,
        rol: user.rol,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || "8h",
      }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        nombre: user.nombre,
        correo: user.correo,
        rol: user.rol,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/me", requireAdminAuth, async (req, res) => {
  res.json({
    ok: true,
    user: req.admin,
  });
});

function buildCotizacionesWhere(query) {
  const conditions = [];
  const params = [];

  const estado = cleanString(query.estado);
  const q = cleanString(query.q);
  const fechaDesde = cleanString(query.fecha_desde);
  const fechaHasta = cleanString(query.fecha_hasta);

  if (estado) {
    conditions.push("c.estado = ?");
    params.push(estado);
  }

  if (fechaDesde) {
    conditions.push("c.created_at >= ?");
    params.push(`${fechaDesde} 00:00:00`);
  }

  if (fechaHasta) {
    conditions.push("c.created_at <= ?");
    params.push(`${fechaHasta} 23:59:59`);
  }

  if (q) {
    conditions.push(`
      (
        c.folio LIKE ?
        OR c.nombre_cliente LIKE ?
        OR c.whatsapp LIKE ?
        OR c.correo LIKE ?
        OR c.ciudad LIKE ?
        OR c.estado_cliente LIKE ?
        OR c.marca_vehiculo LIKE ?
        OR c.modelo_vehiculo LIKE ?
        OR c.motor_vehiculo LIKE ?
      )
    `);

    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like, like);
  }

  const whereSql = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  return {
    whereSql,
    params,
  };
}

function isInvalidPublicCode(value) {
  if (value === undefined || value === null) return true;

  const clean = String(value).trim().toUpperCase();

  return (
    clean === "" ||
    [
      "#N/A",
      "N/A",
      "NA",
      "ND",
      "N.D.",
      "SIN CODIGO",
      "SIN CÓDIGO",
      "NULL",
      "0",
    ].includes(clean)
  );
}

function buildProductoRevisionSql() {
  return `
    CASE
      WHEN
        (
          p.codigo_andyfers IS NULL
          OR TRIM(p.codigo_andyfers) = ''
          OR UPPER(TRIM(p.codigo_andyfers)) IN (
            '#N/A', 'N/A', 'NA', 'ND', 'N.D.', 'SIN CODIGO', 'SIN CÓDIGO', 'NULL', '0'
          )
        )
        AND
        (
          p.codigo_importacion IS NULL
          OR TRIM(p.codigo_importacion) = ''
          OR UPPER(TRIM(p.codigo_importacion)) IN (
            '#N/A', 'N/A', 'NA', 'ND', 'N.D.', 'SIN CODIGO', 'SIN CÓDIGO', 'NULL', '0'
          )
        )
      THEN 'SIN_CODIGO_VALIDO'

      WHEN p.descripcion IS NULL OR TRIM(p.descripcion) = ''
      THEN 'SIN_DESCRIPCION'

      WHEN p.familia IS NULL OR TRIM(p.familia) = ''
      THEN 'SIN_FAMILIA'

      WHEN p.armadora IS NULL OR TRIM(p.armadora) = ''
      THEN 'SIN_ARMADORA'

      ELSE 'OK'
    END
  `;
}
function buildValidProductoCodeSql(alias = "p") {
  return `
    (
      (
        ${alias}.codigo_andyfers IS NOT NULL
        AND TRIM(${alias}.codigo_andyfers) <> ''
        AND UPPER(TRIM(${alias}.codigo_andyfers)) NOT IN (
          '#N/A', 'N/A', 'NA', 'ND', 'N.D.', 'SIN CODIGO', 'SIN CÓDIGO', 'NULL', '0'
        )
      )
      OR
      (
        ${alias}.codigo_importacion IS NOT NULL
        AND TRIM(${alias}.codigo_importacion) <> ''
        AND UPPER(TRIM(${alias}.codigo_importacion)) NOT IN (
          '#N/A', 'N/A', 'NA', 'ND', 'N.D.', 'SIN CODIGO', 'SIN CÓDIGO', 'NULL', '0'
        )
      )
    )
  `;
}

function buildPublicVisibilitySql(alias = "p") {
  return `
    (
      ${alias}.activo = 1
      AND ${alias}.activo_web = 1
      AND ${buildValidProductoCodeSql(alias)}
    )
  `;
}

function buildAdminProductoMultimediaSelectSql(alias = "p") {
  return `
    (
      SELECT pm.thumbnail_url
      FROM producto_multimedia pm
      WHERE pm.producto_id = ${alias}.id
        AND pm.tipo = 'IMAGEN'
        AND pm.activo = 1
      ORDER BY
        CASE pm.rol
          WHEN 'PRINCIPAL' THEN 0
          WHEN 'GALERIA' THEN 1
          ELSE 2
        END,
        pm.orden ASC,
        pm.id ASC
      LIMIT 1
    ) AS imagen_thumbnail_url,

    (
      SELECT COUNT(*)
      FROM producto_multimedia pm
      WHERE pm.producto_id = ${alias}.id
        AND pm.activo = 1
    ) AS total_multimedia
  `;
}

function buildProductosWhere(query) {
  const conditions = [];
  const params = [];

  const q = cleanString(query.q);
  const familia = cleanString(query.familia);
  const estadoRevision = cleanString(query.estado_revision);
  const visibilidadPublica = cleanString(query.visibilidad_publica);
  const activo = cleanString(query.activo);

  if (q) {
    conditions.push(`
      (
        p.codigo_andyfers LIKE ?
        OR p.codigo_importacion LIKE ?
        OR p.descripcion LIKE ?
        OR p.familia LIKE ?
        OR p.armadora LIKE ?
      )
    `);

    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  if (familia) {
    conditions.push("p.familia = ?");
    params.push(familia);
  }

  if (visibilidadPublica === "VISIBLE") {
    conditions.push(buildPublicVisibilitySql("p"));
  }

  if (visibilidadPublica === "OCULTO") {
    conditions.push(`NOT ${buildPublicVisibilitySql("p")}`);
  }

  if (activo === "0" || activo === "1") {
    conditions.push("p.activo = ?");
    params.push(Number(activo));
  }

  if (estadoRevision) {
    conditions.push(`${buildProductoRevisionSql()} = ?`);
    params.push(estadoRevision);
  }

  const whereSql = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  return {
    whereSql,
    params,
  };
}

router.get("/admin/cotizaciones", requireAdminAuth, async (req, res, next) => {
  try {
    const { page, limit, offset } = buildPagination(req.query);
    const { whereSql, params } = buildCotizacionesWhere(req.query);

    const [countRows] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM cotizaciones c
      ${whereSql}
      `,
      params
    );

    const total = Number(countRows?.[0]?.total || 0);

    const [rows] = await pool.query(
      `
      SELECT
        c.id,
        c.folio,
        c.nombre_cliente,
        c.whatsapp,
        c.correo,
        c.ciudad,
        c.estado_cliente,
        c.marca_vehiculo,
        c.modelo_vehiculo,
        c.anio_vehiculo,
        c.motor_vehiculo,
        c.origen,
        c.estado,
        c.created_at,
        c.updated_at,
        COUNT(ci.id) AS total_items,
        COALESCE(SUM(ci.cantidad), 0) AS total_piezas
      FROM cotizaciones c
      LEFT JOIN cotizacion_items ci ON ci.cotizacion_id = c.id
      ${whereSql}
      GROUP BY
        c.id,
        c.folio,
        c.nombre_cliente,
        c.whatsapp,
        c.correo,
        c.ciudad,
        c.estado_cliente,
        c.marca_vehiculo,
        c.modelo_vehiculo,
        c.anio_vehiculo,
        c.motor_vehiculo,
        c.origen,
        c.estado,
        c.created_at,
        c.updated_at
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/cotizaciones/resumen", requireAdminAuth, async (req, res, next) => {
  try {
    const { whereSql, params } = buildCotizacionesWhere(req.query);

    const [rows] = await pool.query(
      `
      SELECT
        COUNT(*) AS total,

        SUM(CASE WHEN c.estado = 'NUEVA' THEN 1 ELSE 0 END) AS nuevas,
        SUM(CASE WHEN c.estado = 'EN_REVISION' THEN 1 ELSE 0 END) AS en_revision,
        SUM(CASE WHEN c.estado = 'CONTACTADO' THEN 1 ELSE 0 END) AS contactado,
        SUM(CASE WHEN c.estado = 'COTIZADO' THEN 1 ELSE 0 END) AS cotizado,
        SUM(CASE WHEN c.estado = 'EN_PROCESO' THEN 1 ELSE 0 END) AS en_proceso,
        SUM(CASE WHEN c.estado = 'CERRADO' THEN 1 ELSE 0 END) AS cerrado,
        SUM(CASE WHEN c.estado = 'CANCELADO' THEN 1 ELSE 0 END) AS cancelado,
        SUM(CASE WHEN c.estado = 'REQUIERE_DATOS' THEN 1 ELSE 0 END) AS requiere_datos,

        SUM(
          CASE
            WHEN c.estado IN ('NUEVA', 'EN_REVISION', 'CONTACTADO', 'REQUIERE_DATOS')
            THEN 1
            ELSE 0
          END
        ) AS pendientes,

        SUM(CASE WHEN DATE(c.created_at) = CURDATE() THEN 1 ELSE 0 END) AS nuevas_hoy
      FROM cotizaciones c
      ${whereSql}
      `,
      params
    );

    const resumen = rows?.[0] || {};

    res.json({
      ok: true,
      data: {
        total: Number(resumen.total || 0),
        nuevas: Number(resumen.nuevas || 0),
        en_revision: Number(resumen.en_revision || 0),
        contactado: Number(resumen.contactado || 0),
        cotizado: Number(resumen.cotizado || 0),
        en_proceso: Number(resumen.en_proceso || 0),
        cerrado: Number(resumen.cerrado || 0),
        cancelado: Number(resumen.cancelado || 0),
        requiere_datos: Number(resumen.requiere_datos || 0),
        pendientes: Number(resumen.pendientes || 0),
        nuevas_hoy: Number(resumen.nuevas_hoy || 0),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/cotizaciones/:folio", requireAdminAuth, async (req, res, next) => {
  try {
    const folio = cleanString(req.params.folio);

    const [cotizaciones] = await pool.query(
      `
      SELECT
        *
      FROM cotizaciones
      WHERE folio = ?
      LIMIT 1
      `,
      [folio]
    );

    const cotizacion = cotizaciones?.[0];

    if (!cotizacion) {
      return res.status(404).json({
        ok: false,
        error: "Cotización no encontrada.",
      });
    }

    const [items] = await pool.query(
      `
      SELECT
        *
      FROM cotizacion_items
      WHERE cotizacion_id = ?
      ORDER BY id ASC
      `,
      [cotizacion.id]
    );

    const [eventos] = await pool.query(
      `
      SELECT
        *
      FROM cotizacion_eventos
      WHERE cotizacion_id = ?
      ORDER BY created_at DESC, id DESC
      `,
      [cotizacion.id]
    );

    res.json({
      ok: true,
      data: {
        ...cotizacion,
        items,
        eventos,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/admin/cotizaciones/:folio/estado",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const folio = cleanString(req.params.folio);
      const estadoNuevo = cleanString(req.body.estado);
      const comentario = cleanString(req.body.comentario);

      if (!ESTADOS_VALIDOS.includes(estadoNuevo)) {
        return res.status(400).json({
          ok: false,
          error: "Estado inválido.",
          estados_validos: ESTADOS_VALIDOS,
        });
      }

      await connection.beginTransaction();

      const [rows] = await connection.query(
        `
        SELECT
          id,
          estado
        FROM cotizaciones
        WHERE folio = ?
        LIMIT 1
        FOR UPDATE
        `,
        [folio]
      );

      const cotizacion = rows?.[0];

      if (!cotizacion) {
        await connection.rollback();

        return res.status(404).json({
          ok: false,
          error: "Cotización no encontrada.",
        });
      }

      const estadoAnterior = cotizacion.estado;

      await connection.query(
        `
        UPDATE cotizaciones
        SET estado = ?
        WHERE id = ?
        `,
        [estadoNuevo, cotizacion.id]
      );

      await connection.query(
        `
        INSERT INTO cotizacion_eventos (
          cotizacion_id,
          estado_anterior,
          estado_nuevo,
          comentario,
          usuario_interno
        )
        VALUES (?, ?, ?, ?, ?)
        `,
        [
          cotizacion.id,
          estadoAnterior,
          estadoNuevo,
          comentario || `Estado cambiado a ${estadoNuevo}.`,
          req.admin.correo,
        ]
      );

      await connection.commit();

      res.json({
        ok: true,
        message: "Estado actualizado correctamente.",
        data: {
          folio,
          estado_anterior: estadoAnterior,
          estado_nuevo: estadoNuevo,
        },
      });
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
);

router.post("/admin/cotizaciones/:folio/eventos",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const folio = cleanString(req.params.folio);
      const comentario = cleanString(req.body.comentario);

      if (!comentario) {
        return res.status(400).json({
          ok: false,
          error: "El comentario es obligatorio.",
        });
      }

      const [rows] = await pool.query(
        `
        SELECT
          id,
          estado
        FROM cotizaciones
        WHERE folio = ?
        LIMIT 1
        `,
        [folio]
      );

      const cotizacion = rows?.[0];

      if (!cotizacion) {
        return res.status(404).json({
          ok: false,
          error: "Cotización no encontrada.",
        });
      }

      await pool.query(
        `
        INSERT INTO cotizacion_eventos (
          cotizacion_id,
          estado_anterior,
          estado_nuevo,
          comentario,
          usuario_interno
        )
        VALUES (?, ?, ?, ?, ?)
        `,
        [
          cotizacion.id,
          cotizacion.estado,
          cotizacion.estado,
          comentario,
          req.admin.correo,
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Nota agregada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/admin/productos/resumen", requireAdminAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        ${buildProductoRevisionSql()} AS estado_revision,
        COUNT(*) AS total
      FROM productos p
      GROUP BY estado_revision
      ORDER BY total DESC
      `
    );

    const resumen = {
      total: 0,
      ok: 0,
      sin_codigo_valido: 0,
      sin_descripcion: 0,
      sin_familia: 0,
      sin_armadora: 0,
    };

    rows.forEach((row) => {
      const total = Number(row.total || 0);
      resumen.total += total;

      if (row.estado_revision === "OK") resumen.ok = total;
      if (row.estado_revision === "SIN_CODIGO_VALIDO") resumen.sin_codigo_valido = total;
      if (row.estado_revision === "SIN_DESCRIPCION") resumen.sin_descripcion = total;
      if (row.estado_revision === "SIN_FAMILIA") resumen.sin_familia = total;
      if (row.estado_revision === "SIN_ARMADORA") resumen.sin_armadora = total;
    });

    res.json({
      ok: true,
      data: resumen,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/productos", requireAdminAuth, async (req, res, next) => {
  try {
    const { page, limit, offset } = buildPagination(req.query);
    const { whereSql, params } = buildProductosWhere(req.query);

    const [countRows] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM productos p
      ${whereSql}
      `,
      params
    );

    const total = Number(countRows?.[0]?.total || 0);

    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        p.codigo_andyfers,
        p.codigo_importacion,
        p.familia,
        p.armadora,
        p.descripcion,
        p.activo,
        p.activo_web,
        p.prioridad_ia,
        p.created_at,
        p.updated_at,
        ${buildProductoRevisionSql()} AS estado_revision,
        ${buildPublicVisibilitySql("p")} AS visible_publico,
        CASE
          WHEN ${buildPublicVisibilitySql("p")}
          THEN 'VISIBLE_PUBLICO'
          WHEN p.activo_web = 0
          THEN 'OCULTO_MANUAL'
          WHEN p.activo = 0
          THEN 'INACTIVO'
          WHEN NOT ${buildValidProductoCodeSql("p")}
          THEN 'SIN_CODIGO_VALIDO'
          ELSE 'NO_VISIBLE'
        END AS motivo_visibilidad,
        c.nombre AS categoria_nombre,
        ${buildAdminProductoMultimediaSelectSql("p")}
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      ${whereSql}
      ORDER BY
        CASE ${buildProductoRevisionSql()}
          WHEN 'SIN_CODIGO_VALIDO' THEN 1
          WHEN 'SIN_DESCRIPCION' THEN 2
          WHEN 'SIN_FAMILIA' THEN 3
          WHEN 'SIN_ARMADORA' THEN 4
          ELSE 5
        END ASC,
        p.updated_at DESC,
        p.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/productos/:id", requireAdminAuth, async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id)) {
      return res.status(400).json({
        ok: false,
        error: "ID de producto inválido.",
      });
    }

    const [rows] = await pool.query(
      `
      SELECT
        p.*,
        ${buildProductoRevisionSql()} AS estado_revision,
        c.nombre AS categoria_nombre
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.id = ?
      LIMIT 1
      `,
      [id]
    );

    const producto = rows?.[0];

    if (!producto) {
      return res.status(404).json({
        ok: false,
        error: "Producto no encontrado.",
      });
    }

    const [atributos] = await pool.query(
      `
      SELECT
        id,
        atributo,
        valor_texto,
        valor_numero,
        unidad,
        visible_web,
        buscable,
        orden
      FROM producto_atributos
      WHERE producto_id = ?
      ORDER BY orden ASC, atributo ASC
      `,
      [id]
    );

    const [cruces] = await pool.query(
      `
      SELECT
        pc.id,
        pc.numero_parte,
        mc.nombre AS marca
      FROM producto_cruces pc
      JOIN marcas_cruce mc ON mc.id = pc.marca_id
      WHERE pc.producto_id = ?
      ORDER BY mc.nombre ASC, pc.numero_parte ASC
      `,
      [id]
    );

    const [multimedia] = await pool.query(
      `
      SELECT
        id,
        tipo,
        rol,
        cloudinary_public_id,
        secure_url,
        thumbnail_url,
        codigo_archivo_original,
        nombre_archivo_original,
        orden,
        activo,
        created_at,
        updated_at
      FROM producto_multimedia
      WHERE producto_id = ?
      ORDER BY
        activo DESC,
        CASE rol
          WHEN 'PRINCIPAL' THEN 0
          WHEN 'GALERIA' THEN 1
          WHEN 'VIDEO' THEN 2
          ELSE 3
        END,
        orden ASC,
        id ASC
      `,
      [id]
    );

    res.json({
      ok: true,
      data: {
        ...producto,
        atributos,
        cruces,
        multimedia,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/admin/productos/:id",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(id)) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const codigoAndyfers = cleanString(req.body.codigo_andyfers);
      const codigoImportacion = cleanString(req.body.codigo_importacion);
      const familia = cleanString(req.body.familia);
      const armadora = cleanString(req.body.armadora);
      const descripcion = cleanString(req.body.descripcion);
      const unidadMedida = cleanString(req.body.unidad_medida) || "PZA";
      const prioridadIa = Number.parseInt(req.body.prioridad_ia, 10);

      const activoWeb =
        req.body.activo_web === true ||
          req.body.activo_web === 1 ||
          req.body.activo_web === "1"
          ? 1
          : 0;

      const activo =
        req.body.activo === true ||
          req.body.activo === 1 ||
          req.body.activo === "1"
          ? 1
          : 0;

      if (isInvalidPublicCode(codigoAndyfers) && isInvalidPublicCode(codigoImportacion)) {
        return res.status(400).json({
          ok: false,
          error:
            "El producto debe tener al menos código Andyfers o código importación válido.",
        });
      }

      if (!descripcion) {
        return res.status(400).json({
          ok: false,
          error: "La descripción es obligatoria.",
        });
      }

      if (!familia) {
        return res.status(400).json({
          ok: false,
          error: "La familia es obligatoria.",
        });
      }

      await pool.query(
        `
        UPDATE productos
        SET
          codigo_andyfers = ?,
          codigo_andyfers_normalizado = ?,
          codigo_importacion = ?,
          familia = ?,
          armadora = ?,
          descripcion = ?,
          unidad_medida = ?,
          prioridad_ia = ?,
          activo_web = ?,
          activo = ?
        WHERE id = ?
        `,
        [
          codigoAndyfers,
          codigoAndyfers ? normalizePartNumber(codigoAndyfers) : null,
          codigoImportacion,
          familia,
          armadora,
          descripcion,
          unidadMedida,
          Number.isFinite(prioridadIa) ? prioridadIa : 50,
          activoWeb,
          activo,
          id,
        ]
      );

      res.json({
        ok: true,
        message: "Producto actualizado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);


function parseBooleanFlag(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;

  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;

  const clean = String(value).trim().toLowerCase();

  if (["true", "si", "sí", "activo", "active"].includes(clean)) return 1;
  if (["false", "no", "inactivo", "inactive"].includes(clean)) return 0;

  return fallback;
}

function cleanDateTime(value) {
  const clean = cleanString(value);

  if (!clean) return null;

  // datetime-local del navegador llega como YYYY-MM-DDTHH:mm.
  return clean.replace("T", " ").slice(0, 19);
}

function validateHomeHeroSlidePayload(body = {}) {
  const errors = [];
  const secureUrl = cleanString(body.secure_url);

  if (!secureUrl) {
    errors.push("La URL segura de Cloudinary es obligatoria.");
  }

  if (secureUrl && !/^https:\/\/res\.cloudinary\.com\//i.test(secureUrl)) {
    errors.push("La imagen debe venir de una URL segura de Cloudinary.");
  }

  return errors;
}

router.get("/admin/home/hero-slides", requireAdminAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        id,
        titulo,
        subtitulo,
        etiqueta,
        texto_boton,
        url_boton,
        cloudinary_public_id,
        secure_url,
        thumbnail_url,
        orden,
        activo,
        fecha_inicio,
        fecha_fin,
        created_at,
        updated_at
      FROM home_hero_slides
      ORDER BY activo DESC, orden ASC, id ASC
      `
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/admin/home/hero-slides",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const errors = validateHomeHeroSlidePayload(req.body);

      if (errors.length) {
        return res.status(400).json({
          ok: false,
          error: "Datos inválidos para crear el flyer.",
          errors,
        });
      }

      const orden = Number.parseInt(req.body.orden, 10);

      const [result] = await pool.query(
        `
        INSERT INTO home_hero_slides (
          titulo,
          subtitulo,
          etiqueta,
          texto_boton,
          url_boton,
          cloudinary_public_id,
          secure_url,
          thumbnail_url,
          orden,
          activo,
          fecha_inicio,
          fecha_fin
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          cleanString(req.body.titulo),
          cleanString(req.body.subtitulo),
          cleanString(req.body.etiqueta),
          cleanString(req.body.texto_boton),
          cleanString(req.body.url_boton),
          cleanString(req.body.cloudinary_public_id),
          cleanString(req.body.secure_url),
          cleanString(req.body.thumbnail_url),
          Number.isFinite(orden) ? orden : 0,
          parseBooleanFlag(req.body.activo, 1),
          cleanDateTime(req.body.fecha_inicio),
          cleanDateTime(req.body.fecha_fin),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Flyer creado correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/admin/home/hero-slides/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(id)) {
        return res.status(400).json({
          ok: false,
          error: "ID de flyer inválido.",
        });
      }

      const errors = validateHomeHeroSlidePayload(req.body);

      if (errors.length) {
        return res.status(400).json({
          ok: false,
          error: "Datos inválidos para actualizar el flyer.",
          errors,
        });
      }

      const orden = Number.parseInt(req.body.orden, 10);

      const [result] = await pool.query(
        `
        UPDATE home_hero_slides
        SET
          titulo = ?,
          subtitulo = ?,
          etiqueta = ?,
          texto_boton = ?,
          url_boton = ?,
          cloudinary_public_id = ?,
          secure_url = ?,
          thumbnail_url = ?,
          orden = ?,
          activo = ?,
          fecha_inicio = ?,
          fecha_fin = ?
        WHERE id = ?
        `,
        [
          cleanString(req.body.titulo),
          cleanString(req.body.subtitulo),
          cleanString(req.body.etiqueta),
          cleanString(req.body.texto_boton),
          cleanString(req.body.url_boton),
          cleanString(req.body.cloudinary_public_id),
          cleanString(req.body.secure_url),
          cleanString(req.body.thumbnail_url),
          Number.isFinite(orden) ? orden : 0,
          parseBooleanFlag(req.body.activo, 1),
          cleanDateTime(req.body.fecha_inicio),
          cleanDateTime(req.body.fecha_fin),
          id,
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Flyer no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Flyer actualizado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  "/admin/home/hero-slides/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(id)) {
        return res.status(400).json({
          ok: false,
          error: "ID de flyer inválido.",
        });
      }

      const [result] = await pool.query(
        `
        UPDATE home_hero_slides
        SET activo = 0
        WHERE id = ?
        `,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Flyer no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Flyer desactivado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;