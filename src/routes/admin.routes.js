import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";
import { normalizePartNumber, normalizeText } from "../utils/normalize.js";
import { cleanString, parsePositiveInt, buildPagination } from "../utils/queryHelpers.js";
import {
  buildApplicationMotorFromPayload,
  buildApplicationMotorLabelSql,
} from "../utils/applicationMotor.js";

const router = Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Solo se permiten imagenes."));
    }
    return cb(null, true);
  },
});

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

//AUTENTICACION
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

//COTIZACIONES
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

//PRODUCTOS
function parseTinyBoolean(value, defaultValue = 0) {
  if (value === undefined || value === null || value === "") return defaultValue;

  if (value === true || value === 1 || value === "1" || value === "true") {
    return 1;
  }

  return 0;
}

function parseMediaOrder(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) return fallback;

  return Math.min(parsed, 9999);
}

function cleanMediaRole(value) {
  const rol = cleanString(value) || "GALERIA";
  const upper = rol.toUpperCase();

  if (["PRINCIPAL", "GALERIA", "VIDEO"].includes(upper)) {
    return upper;
  }

  return "GALERIA";
}

function cleanMediaType(value) {
  const tipo = cleanString(value) || "IMAGEN";
  const upper = tipo.toUpperCase();

  if (["IMAGEN", "VIDEO"].includes(upper)) {
    return upper;
  }

  return "IMAGEN";
}

function buildThumbnailUrl(secureUrl) {
  if (!secureUrl || !String(secureUrl).includes("/upload/")) {
    return secureUrl || null;
  }

  return String(secureUrl).replace(
    "/upload/",
    "/upload/f_auto,q_auto,c_fill,w_420,h_320/",
    1
  );
}

function sanitizeCloudinarySegment(value) {
  const clean = normalizePartNumber(value || "");

  return clean || "SIN-CODIGO";
}

function buildProductMediaPublicId(producto, fileName, rol) {
  const codigo = sanitizeCloudinarySegment(
    producto.codigo_andyfers || producto.codigo_importacion || producto.id
  );

  const rawFile = String(fileName || "imagen")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 70);

  if (rol === "PRINCIPAL") {
    return `andyfers/productos/${codigo}/principal`;
  }

  return `andyfers/productos/${codigo}/galeria/${Date.now()}_${rawFile}`;
}

function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );

    stream.end(buffer);
  });
}

async function getProductoForAdminMedia(connection, productoId) {
  const [rows] = await connection.query(
    `
    SELECT
      id,
      codigo_andyfers,
      codigo_importacion,
      descripcion
    FROM productos
    WHERE id = ?
    LIMIT 1
    `,
    [productoId]
  );

  return rows?.[0] || null;
}

async function validateMediaBelongsToProduct(connection, productoId, mediaId) {
  const [rows] = await connection.query(
    `
    SELECT
      id,
      producto_id,
      rol,
      activo
    FROM producto_multimedia
    WHERE id = ?
      AND producto_id = ?
    LIMIT 1
    `,
    [mediaId, productoId]
  );

  return rows?.[0] || null;
}

async function demoteOtherPrincipalMedia(connection, productoId, exceptMediaId = null) {
  const params = [productoId];

  let exceptSql = "";

  if (exceptMediaId) {
    exceptSql = "AND id <> ?";
    params.push(exceptMediaId);
  }

  await connection.query(
    `
    UPDATE producto_multimedia
    SET
      rol = 'GALERIA',
      updated_at = CURRENT_TIMESTAMP
    WHERE producto_id = ?
      AND tipo = 'IMAGEN'
      AND rol = 'PRINCIPAL'
      AND activo = 1
      ${exceptSql}
    `,
    params
  );
}

function m62CleanString(value) {
  if (value === undefined || value === null) return null;

  const clean = String(value).trim();

  return clean || null;
}

function m62CleanRequiredString(value) {
  if (value === undefined || value === null) return "";

  return String(value).trim();
}

function m62ParseInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return fallback;

  return parsed;
}

function m62ParseDecimal(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;

  return parsed;
}

function m62ParseTiny(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;

  if (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true"
  ) {
    return 1;
  }

  return 0;
}

function m62CleanTipoMarcaProducto(value) {
  const clean = String(value || "DESCONOCIDA").trim().toUpperCase();

  if (["OEM", "AFTERMARKET", "GENERICA", "DESCONOCIDA"].includes(clean)) {
    return clean;
  }

  return "DESCONOCIDA";
}

function m62NormalizeProductCode(value) {
  if (!value) return null;

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "") || null;
}

function m62BuildProductPayload(body = {}) {
  const codigoAndyfers = m62CleanString(body.codigo_andyfers);
  const codigoImportacion = m62CleanString(body.codigo_importacion);

  return {
    codigo_andyfers: codigoAndyfers,
    codigo_andyfers_normalizado: m62NormalizeProductCode(codigoAndyfers),
    codigo_importacion: codigoImportacion,
    slug: m62CleanString(body.slug),

    categoria_id: m62ParseInt(body.categoria_id, null),

    clasif_vta: m62CleanString(body.clasif_vta),
    armadora: m62CleanString(body.armadora),
    familia: m62CleanString(body.familia),

    marca_producto: m62CleanString(body.marca_producto),
    tipo_marca_producto: m62CleanTipoMarcaProducto(body.tipo_marca_producto),
    marca_producto_confirmada: m62ParseTiny(body.marca_producto_confirmada, 0),

    descripcion: m62CleanRequiredString(body.descripcion),
    imagen_url: m62CleanString(body.imagen_url),
    descripcion_web: m62CleanString(body.descripcion_web),

    multiplo: m62ParseDecimal(body.multiplo, null),
    unidad_medida: m62CleanString(body.unidad_medida) || "PZA",

    prioridad_ia: m62ParseInt(body.prioridad_ia, 0),

    destacado: m62ParseTiny(body.destacado, 0),
    nuevo_web: m62ParseTiny(body.nuevo_web, 0),
    visible_catalogo: m62ParseTiny(body.visible_catalogo, 1),
    activo_web: m62ParseTiny(body.activo_web, 1),
    activo: m62ParseTiny(body.activo, 1),
    stock: m62ParseInt(body.stock, null),
    precio: m62ParseDecimal(body.precio, null),
    precio_publico: m62ParseDecimal(body.precio_publico, null),
  };
}

function m62ValidateProductPayload(payload, { creating = false } = {}) {
  const errors = [];

  if (creating && !payload.categoria_id) {
    errors.push("La categoría es obligatoria.");
  }

  if (!payload.descripcion) {
    errors.push("La descripción es obligatoria.");
  }

  if (!payload.codigo_andyfers && !payload.codigo_importacion) {
    errors.push("Debes capturar al menos código Andyfers o código importación.");
  }

  return errors;
}

function m62HasInventoryPayload(payload = {}) {
  return (
    payload.stock !== null ||
    payload.precio !== null ||
    payload.precio_publico !== null
  );
}

async function m62GetEcommerceSucursal(connection) {
  const clave = cleanString(process.env.ECOMMERCE_SUCURSAL_CLAVE || "ECOMMERCE");

  const [rows] = await connection.query(
    `
    SELECT id, nombre, clave
    FROM sucursales
    WHERE clave = ?
      AND activo = 1
    LIMIT 1
    `,
    [clave]
  );

  const sucursal = rows?.[0];

  if (!sucursal) {
    const error = new Error(`No existe almacén ecommerce con clave ${clave}.`);
    error.status = 500;
    throw error;
  }

  return sucursal;
}

async function m62UpsertEcommerceInventario(connection, productoId, payload = {}) {
  if (!m62HasInventoryPayload(payload)) return;

  const sucursal = await m62GetEcommerceSucursal(connection);

  const stock = Math.max(Number(payload.stock || 0), 0);
  const precio = payload.precio === null ? null : Number(payload.precio);
  const precioPublico =
    payload.precio_publico === null ? null : Number(payload.precio_publico);

  const disponibleWeb = stock > 0 && Number(precioPublico || 0) > 0 ? 1 : 0;
  const mostrarPrecio = Number(precioPublico || 0) > 0 ? 1 : 0;

  await connection.query(
    `
    INSERT INTO inventario (
      producto_id,
      sucursal_id,
      stock,
      precio,
      precio_publico,
      multiplo_venta,
      mostrar_precio,
      disponible_cotizacion,
      disponible_web
    )
    VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)
    ON DUPLICATE KEY UPDATE
      stock = VALUES(stock),
      precio = VALUES(precio),
      precio_publico = VALUES(precio_publico),
      mostrar_precio = VALUES(mostrar_precio),
      disponible_cotizacion = 1,
      disponible_web = VALUES(disponible_web),
      updated_at = NOW()
    `,
    [
      productoId,
      sucursal.id,
      stock,
      precio,
      precioPublico,
      mostrarPrecio,
      disponibleWeb,
    ]
  );
}

//VISIBILIDAD Y ESTADO
function m64ValidPublicCodeSql(alias = "p") {
  const invalidValues = `
    '#N/A',
    'N/A',
    'NA',
    'ND',
    'N.D.',
    'SIN CODIGO',
    'SIN CÓDIGO',
    'NULL',
    '0'
  `;

  return `
    (
      (
        ${alias}.codigo_andyfers IS NOT NULL
        AND TRIM(${alias}.codigo_andyfers) <> ''
        AND UPPER(TRIM(${alias}.codigo_andyfers)) NOT IN (${invalidValues})
      )
      OR
      (
        ${alias}.codigo_importacion IS NOT NULL
        AND TRIM(${alias}.codigo_importacion) <> ''
        AND UPPER(TRIM(${alias}.codigo_importacion)) NOT IN (${invalidValues})
      )
    )
  `;
}

function m64EstadoRevisionSql(alias = "p") {
  return `
    CASE
      WHEN NOT ${m64ValidPublicCodeSql(alias)} THEN 'SIN_CODIGO_VALIDO'
      WHEN ${alias}.descripcion IS NULL OR TRIM(${alias}.descripcion) = '' THEN 'SIN_DESCRIPCION'
      WHEN ${alias}.familia IS NULL OR TRIM(${alias}.familia) = '' THEN 'SIN_FAMILIA'
      WHEN ${alias}.armadora IS NULL OR TRIM(${alias}.armadora) = '' THEN 'SIN_ARMADORA'
      ELSE 'OK'
    END
  `;
}

function m64VisiblePublicoSql(alias = "p") {
  return `
    CASE
      WHEN ${alias}.activo = 1
        AND ${alias}.activo_web = 1
        AND ${alias}.visible_catalogo = 1
        AND ${m64ValidPublicCodeSql(alias)}
      THEN 1
      ELSE 0
    END
  `;
}

function m64MotivoVisibilidadSql(alias = "p") {
  return `
    CASE
      WHEN ${alias}.activo <> 1 THEN 'INACTIVO_INTERNO'
      WHEN ${alias}.activo_web <> 1 THEN 'ACTIVO_WEB_APAGADO'
      WHEN ${alias}.visible_catalogo <> 1 THEN 'VISIBLE_CATALOGO_APAGADO'
      WHEN NOT ${m64ValidPublicCodeSql(alias)} THEN 'SIN_CODIGO_VALIDO'
      WHEN ${alias}.descripcion IS NULL OR TRIM(${alias}.descripcion) = '' THEN 'SIN_DESCRIPCION'
      WHEN ${alias}.familia IS NULL OR TRIM(${alias}.familia) = '' THEN 'SIN_FAMILIA'
      WHEN ${alias}.armadora IS NULL OR TRIM(${alias}.armadora) = '' THEN 'SIN_ARMADORA'
      ELSE 'VISIBLE'
    END
  `;
}

function m64HasMultimediaSql(alias = "p") {
  return `
    EXISTS (
      SELECT 1
      FROM producto_multimedia pm_m64
      WHERE pm_m64.producto_id = ${alias}.id
        AND pm_m64.tipo = 'IMAGEN'
        AND pm_m64.activo = 1
    )
  `;
}

function m64ParseTiny(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  if (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true"
  ) {
    return 1;
  }

  if (
    value === false ||
    value === 0 ||
    value === "0" ||
    String(value).toLowerCase() === "false"
  ) {
    return 0;
  }

  return fallback;
}

router.get("/admin/productos/catalogos/categorias",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query(`
        SELECT
          id,
          nombre,
          nombre_normalizado,
          activo
        FROM categorias
        WHERE activo = 1
        ORDER BY nombre ASC
      `);

      res.json({
        ok: true,
        data: rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/admin/productos/resumen",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query(`
        SELECT
          COUNT(*) AS total,

          SUM(CASE WHEN ${m64EstadoRevisionSql("p")} = 'OK' THEN 1 ELSE 0 END) AS ok,
          SUM(CASE WHEN ${m64EstadoRevisionSql("p")} = 'SIN_CODIGO_VALIDO' THEN 1 ELSE 0 END) AS sin_codigo_valido,
          SUM(CASE WHEN ${m64EstadoRevisionSql("p")} = 'SIN_DESCRIPCION' THEN 1 ELSE 0 END) AS sin_descripcion,
          SUM(CASE WHEN ${m64EstadoRevisionSql("p")} = 'SIN_FAMILIA' THEN 1 ELSE 0 END) AS sin_familia,
          SUM(CASE WHEN ${m64EstadoRevisionSql("p")} = 'SIN_ARMADORA' THEN 1 ELSE 0 END) AS sin_armadora,

          SUM(CASE WHEN ${m64HasMultimediaSql("p")} THEN 1 ELSE 0 END) AS con_multimedia,
          SUM(CASE WHEN NOT ${m64HasMultimediaSql("p")} THEN 1 ELSE 0 END) AS sin_multimedia,

          SUM(CASE WHEN ${m64VisiblePublicoSql("p")} = 1 THEN 1 ELSE 0 END) AS visibles_publico,
          SUM(CASE WHEN ${m64VisiblePublicoSql("p")} = 0 THEN 1 ELSE 0 END) AS no_visibles_publico,

          SUM(CASE WHEN p.activo = 1 THEN 1 ELSE 0 END) AS activos_internos,
          SUM(CASE WHEN p.activo <> 1 THEN 1 ELSE 0 END) AS inactivos_internos,

          SUM(CASE WHEN p.activo_web = 1 THEN 1 ELSE 0 END) AS activo_web_on,
          SUM(CASE WHEN p.activo_web <> 1 THEN 1 ELSE 0 END) AS activo_web_off,

          SUM(CASE WHEN p.visible_catalogo = 1 THEN 1 ELSE 0 END) AS visible_catalogo_on,
          SUM(CASE WHEN p.visible_catalogo <> 1 THEN 1 ELSE 0 END) AS visible_catalogo_off,

          SUM(CASE WHEN p.destacado = 1 THEN 1 ELSE 0 END) AS destacados,
          SUM(CASE WHEN p.nuevo_web = 1 THEN 1 ELSE 0 END) AS nuevos_web
        FROM productos p
      `);

      res.json({
        ok: true,
        data: rows?.[0] || {
          total: 0,
          ok: 0,
          sin_codigo_valido: 0,
          sin_descripcion: 0,
          sin_familia: 0,
          sin_armadora: 0,
          con_multimedia: 0,
          sin_multimedia: 0,
          visibles_publico: 0,
          no_visibles_publico: 0,
          activos_internos: 0,
          inactivos_internos: 0,
          activo_web_on: 0,
          activo_web_off: 0,
          visible_catalogo_on: 0,
          visible_catalogo_off: 0,
          destacados: 0,
          nuevos_web: 0,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/admin/productos", requireAdminAuth, async (req, res, next) => {
  try {
    const { page, limit, offset } = buildPagination(req.query);

    const baseWhere = buildProductosWhere(req.query);

    const baseWhereBody = baseWhere.whereSql
      ? baseWhere.whereSql.replace(/^WHERE\s+/i, "")
      : "";

    const conditions = baseWhereBody ? [`(${baseWhereBody})`] : [];
    const params = [...baseWhere.params];

    if (req.query.estado_revision) {
      conditions.push(`${m64EstadoRevisionSql("p")} = ?`);
      params.push(String(req.query.estado_revision));
    }

    if (req.query.visibilidad_publica === "VISIBLE") {
      conditions.push(`${m64VisiblePublicoSql("p")} = 1`);
    }

    if (req.query.visibilidad_publica === "OCULTO") {
      conditions.push(`${m64VisiblePublicoSql("p")} = 0`);
    }

    if (req.query.multimedia === "CON_MULTIMEDIA") {
      conditions.push(`${m64HasMultimediaSql("p")}`);
    }

    if (req.query.multimedia === "SIN_MULTIMEDIA") {
      conditions.push(`NOT ${m64HasMultimediaSql("p")}`);
    }

    if (req.query.activo_web === "1") {
      conditions.push("p.activo_web = 1");
    }

    if (req.query.activo_web === "0") {
      conditions.push("p.activo_web = 0");
    }

    if (req.query.visible_catalogo === "1") {
      conditions.push("p.visible_catalogo = 1");
    }

    if (req.query.visible_catalogo === "0") {
      conditions.push("p.visible_catalogo = 0");
    }

    if (req.query.destacado === "1") {
      conditions.push("p.destacado = 1");
    }

    if (req.query.destacado === "0") {
      conditions.push("p.destacado = 0");
    }

    if (req.query.nuevo_web === "1") {
      conditions.push("p.nuevo_web = 1");
    }

    if (req.query.nuevo_web === "0") {
      conditions.push("p.nuevo_web = 0");
    }

    const finalWhereSql = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const [countRows] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      ${finalWhereSql}
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
        p.categoria_id,
        c.nombre AS categoria_nombre,

        p.familia,
        p.armadora,
        p.descripcion,
        p.unidad_medida,
        p.prioridad_ia,

        p.activo,
        p.activo_web,
        p.visible_catalogo,
        p.destacado,
        p.nuevo_web,

        p.created_at,
        p.updated_at,

        ${m64EstadoRevisionSql("p")} AS estado_revision,
        ${m64VisiblePublicoSql("p")} AS visible_publico,
        ${m64MotivoVisibilidadSql("p")} AS motivo_visibilidad,

        CASE
          WHEN ${m64HasMultimediaSql("p")} THEN 1
          ELSE 0
        END AS tiene_multimedia,

        (
          SELECT COUNT(*)
          FROM producto_multimedia pm_count
          WHERE pm_count.producto_id = p.id
            AND pm_count.tipo = 'IMAGEN'
            AND pm_count.activo = 1
        ) AS total_multimedia,

        ${buildAdminProductoMultimediaSelectSql("p")}
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      ${finalWhereSql}
      ORDER BY
        CASE
          WHEN ${m64EstadoRevisionSql("p")} <> 'OK' THEN 0
          WHEN NOT ${m64HasMultimediaSql("p")} THEN 1
          WHEN ${m64VisiblePublicoSql("p")} = 0 THEN 2
          ELSE 3
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

router.get("/admin/productos/:id",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(productoId)) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const [productos] = await pool.query(
        `
        SELECT
          p.id,
          p.codigo_andyfers,
          p.codigo_andyfers_normalizado,
          p.codigo_importacion,
          p.slug,

          p.categoria_id,
          c.nombre AS categoria_nombre,

          p.clasif_vta,
          p.armadora,
          p.familia,

          p.marca_producto,
          p.tipo_marca_producto,
          p.marca_producto_confirmada,

          p.descripcion,
          p.imagen_url,
          p.descripcion_web,

          p.multiplo,
          p.unidad_medida,
          p.prioridad_ia,

          p.destacado,
          p.nuevo_web,
          p.visible_catalogo,
          p.activo_web,
          p.activo,

          COALESCE(i.stock, 0) AS stock,
          i.precio,
          i.precio_publico,
          COALESCE(i.mostrar_precio, 0) AS mostrar_precio,
          COALESCE(i.disponible_web, 0) AS disponible_web,

          p.created_at,
          p.updated_at,

          CASE
            WHEN (
              (p.codigo_andyfers IS NULL OR TRIM(p.codigo_andyfers) = '')
              AND (p.codigo_importacion IS NULL OR TRIM(p.codigo_importacion) = '')
            ) THEN 'SIN_CODIGO_VALIDO'
            WHEN p.descripcion IS NULL OR TRIM(p.descripcion) = '' THEN 'SIN_DESCRIPCION'
            WHEN p.familia IS NULL OR TRIM(p.familia) = '' THEN 'SIN_FAMILIA'
            WHEN p.armadora IS NULL OR TRIM(p.armadora) = '' THEN 'SIN_ARMADORA'
            ELSE 'OK'
          END AS estado_revision,

          CASE
            WHEN p.activo = 1
              AND p.activo_web = 1
              AND p.visible_catalogo = 1
              AND (
                (p.codigo_andyfers IS NOT NULL AND TRIM(p.codigo_andyfers) <> '')
                OR (p.codigo_importacion IS NOT NULL AND TRIM(p.codigo_importacion) <> '')
              )
            THEN 1
            ELSE 0
          END AS visible_publico,

          CASE
            WHEN p.activo <> 1 THEN 'INACTIVO_INTERNO'
            WHEN p.activo_web <> 1 THEN 'INACTIVO_WEB'
            WHEN p.visible_catalogo <> 1 THEN 'OCULTO_CATALOGO'
            WHEN (
              (p.codigo_andyfers IS NULL OR TRIM(p.codigo_andyfers) = '')
              AND (p.codigo_importacion IS NULL OR TRIM(p.codigo_importacion) = '')
            ) THEN 'SIN_CODIGO_VALIDO'
            ELSE 'VISIBLE'
          END AS motivo_visibilidad
        FROM productos p
        JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN sucursales se ON se.clave = ? AND se.activo = 1
        LEFT JOIN inventario i ON i.producto_id = p.id AND i.sucursal_id = se.id
        WHERE p.id = ?
        LIMIT 1
        `,
        [cleanString(process.env.ECOMMERCE_SUCURSAL_CLAVE || "ECOMMERCE"), productoId]
      );

      const producto = productos?.[0];

      if (!producto) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

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
          CASE rol
            WHEN 'PRINCIPAL' THEN 0
            WHEN 'GALERIA' THEN 1
            WHEN 'VIDEO' THEN 2
            ELSE 3
          END,
          orden ASC,
          id ASC
        `,
        [productoId]
      );

      const [atributos] = await pool.query(
        `
        SELECT
          id,
          atributo,
          atributo_normalizado,
          valor_texto,
          valor_normalizado,
          valor_numero,
          unidad,
          visible_web,
          buscable,
          orden
        FROM producto_atributos
        WHERE producto_id = ?
        ORDER BY orden ASC, atributo ASC
        `,
        [productoId]
      );

      const [cruces] = await pool.query(
        `
        SELECT
          pc.id,
          pc.marca_id,
          mc.nombre AS marca,
          pc.numero_parte,
          pc.numero_parte_normalizado
        FROM producto_cruces pc
        JOIN marcas_cruce mc ON mc.id = pc.marca_id
        WHERE pc.producto_id = ?
        ORDER BY mc.nombre ASC, pc.numero_parte ASC
        `,
        [productoId]
      );

      const [aplicaciones] = await pool.query(
        `
        SELECT
          id,
          marca_auto,
          modelo_auto,
          motor,
          cilindraje,
          motor_detalle,
          motor_original,
          ${buildApplicationMotorLabelSql("producto_aplicaciones")} AS motor_label,
          anio_inicio,
          anio_fin,
          version_auto,
          fuente,
          confianza_extraccion,
          notas
        FROM producto_aplicaciones
        WHERE producto_id = ?
        ORDER BY marca_auto ASC, modelo_auto ASC, anio_inicio ASC
        `,
        [productoId]
      );

      res.json({
        ok: true,
        data: {
          ...producto,
          multimedia,
          atributos,
          cruces,
          aplicaciones,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post("/admin/productos", requireAdminAuth, requireRole(["ADMIN"]),
  async (req, res, next) => {
    let connection;

    try {
      const payload = m62BuildProductPayload(req.body);
      const errors = m62ValidateProductPayload(payload, { creating: true });

      if (errors.length) {
        return res.status(400).json({
          ok: false,
          error: errors.join(" "),
        });
      }

      const [categoriaRows] = await pool.query(
        `
        SELECT id
        FROM categorias
        WHERE id = ?
          AND activo = 1
        LIMIT 1
        `,
        [payload.categoria_id]
      );

      if (!categoriaRows.length) {
        return res.status(400).json({
          ok: false,
          error: "La categoría seleccionada no existe o está inactiva.",
        });
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [result] = await connection.query(
        `
        INSERT INTO productos (
          codigo_andyfers,
          codigo_andyfers_normalizado,
          codigo_importacion,
          slug,
          categoria_id,
          clasif_vta,
          armadora,
          familia,
          marca_producto,
          tipo_marca_producto,
          marca_producto_confirmada,
          descripcion,
          imagen_url,
          descripcion_web,
          multiplo,
          unidad_medida,
          prioridad_ia,
          destacado,
          nuevo_web,
          visible_catalogo,
          activo_web,
          activo
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          payload.codigo_andyfers,
          payload.codigo_andyfers_normalizado,
          payload.codigo_importacion,
          payload.slug,
          payload.categoria_id,
          payload.clasif_vta,
          payload.armadora,
          payload.familia,
          payload.marca_producto,
          payload.tipo_marca_producto,
          payload.marca_producto_confirmada,
          payload.descripcion,
          payload.imagen_url,
          payload.descripcion_web,
          payload.multiplo,
          payload.unidad_medida,
          payload.prioridad_ia,
          payload.destacado,
          payload.nuevo_web,
          payload.visible_catalogo,
          payload.activo_web,
          payload.activo,
        ]
      );

      await m62UpsertEcommerceInventario(connection, result.insertId, payload);

      await connection.commit();

      return res.status(201).json({
        ok: true,
        message: "Producto creado correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      if (connection) {
        await connection.rollback().catch(() => { });
      }

      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe un producto con ese código Andyfers.",
        });
      }

      return next(error);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

router.patch("/admin/productos/:id", requireAdminAuth, requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    let connection;

    try {
      const productoId = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(productoId)) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const payload = m62BuildProductPayload(req.body);
      const errors = m62ValidateProductPayload(payload);

      if (errors.length) {
        return res.status(400).json({
          ok: false,
          error: errors.join(" "),
        });
      }

      if (payload.categoria_id) {
        const [categoriaRows] = await pool.query(
          `
          SELECT id
          FROM categorias
          WHERE id = ?
            AND activo = 1
          LIMIT 1
          `,
          [payload.categoria_id]
        );

        if (!categoriaRows.length) {
          return res.status(400).json({
            ok: false,
            error: "La categoría seleccionada no existe o está inactiva.",
          });
        }
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [result] = await connection.query(
        `
        UPDATE productos
        SET
          codigo_andyfers = ?,
          codigo_andyfers_normalizado = ?,
          codigo_importacion = ?,
          slug = ?,
          categoria_id = COALESCE(?, categoria_id),
          clasif_vta = ?,
          armadora = ?,
          familia = ?,
          marca_producto = ?,
          tipo_marca_producto = ?,
          marca_producto_confirmada = ?,
          descripcion = ?,
          imagen_url = ?,
          descripcion_web = ?,
          multiplo = ?,
          unidad_medida = ?,
          prioridad_ia = ?,
          destacado = ?,
          nuevo_web = ?,
          visible_catalogo = ?,
          activo_web = ?,
          activo = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [
          payload.codigo_andyfers,
          payload.codigo_andyfers_normalizado,
          payload.codigo_importacion,
          payload.slug,
          payload.categoria_id,
          payload.clasif_vta,
          payload.armadora,
          payload.familia,
          payload.marca_producto,
          payload.tipo_marca_producto,
          payload.marca_producto_confirmada,
          payload.descripcion,
          payload.imagen_url,
          payload.descripcion_web,
          payload.multiplo,
          payload.unidad_medida,
          payload.prioridad_ia,
          payload.destacado,
          payload.nuevo_web,
          payload.visible_catalogo,
          payload.activo_web,
          payload.activo,
          productoId,
        ]
      );

      if (result.affectedRows === 0) {
        await connection.rollback();

        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      await m62UpsertEcommerceInventario(connection, productoId, payload);

      await connection.commit();

      return res.json({
        ok: true,
        message: "Producto actualizado correctamente.",
      });
    } catch (error) {
      if (connection) {
        await connection.rollback().catch(() => { });
      }

      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe otro producto con ese código Andyfers.",
        });
      }

      return next(error);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

//HEROS
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

router.post("/admin/home/hero-slides",
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

router.patch("/admin/home/hero-slides/:id",
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

router.delete("/admin/home/hero-slides/:id",
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

//UPLOAD
router.post("/admin/productos/:id/multimedia/upload",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  upload.single("file"),
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const productoId = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(productoId)) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "La imagen es obligatoria.",
        });
      }

      const producto = await getProductoForAdminMedia(connection, productoId);

      if (!producto) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      const rol = cleanMediaRole(req.body.rol);
      const orden = parseMediaOrder(req.body.orden, 1);
      const codigoArchivoOriginal =
        cleanString(req.body.codigo_archivo_original) ||
        cleanString(req.body.codigo_archivo) ||
        null;

      const nombreArchivoOriginal =
        cleanString(req.body.nombre_archivo_original) ||
        req.file.originalname ||
        null;

      const publicId = buildProductMediaPublicId(
        producto,
        req.file.originalname,
        rol
      );

      const uploadResponse = await uploadBufferToCloudinary(req.file.buffer, {
        public_id: publicId,
        resource_type: "image",
        overwrite: rol === "PRINCIPAL",
        unique_filename: false,
        folder: undefined,
        tags: [
          "andyfers",
          "producto",
          sanitizeCloudinarySegment(
            producto.codigo_andyfers || producto.codigo_importacion || producto.id
          ),
          rol.toLowerCase(),
        ],
      });

      const secureUrl = uploadResponse.secure_url;
      const thumbnailUrl = buildThumbnailUrl(secureUrl);

      await connection.beginTransaction();

      if (rol === "PRINCIPAL") {
        await demoteOtherPrincipalMedia(connection, productoId);
      }

      const [insertResult] = await connection.query(
        `
        INSERT INTO producto_multimedia (
          producto_id,
          tipo,
          rol,
          cloudinary_public_id,
          secure_url,
          thumbnail_url,
          codigo_archivo_original,
          nombre_archivo_original,
          orden,
          activo
        )
        VALUES (?, 'IMAGEN', ?, ?, ?, ?, ?, ?, ?, 1)
        `,
        [
          productoId,
          rol,
          uploadResponse.public_id,
          secureUrl,
          thumbnailUrl,
          codigoArchivoOriginal,
          nombreArchivoOriginal,
          orden,
        ]
      );

      await connection.commit();

      res.status(201).json({
        ok: true,
        message: "Imagen subida correctamente.",
        data: {
          id: insertResult.insertId,
          producto_id: productoId,
          tipo: "IMAGEN",
          rol,
          cloudinary_public_id: uploadResponse.public_id,
          secure_url: secureUrl,
          thumbnail_url: thumbnailUrl,
          codigo_archivo_original: codigoArchivoOriginal,
          nombre_archivo_original: nombreArchivoOriginal,
          orden,
          activo: 1,
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

router.post("/admin/productos/:id/multimedia",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const productoId = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(productoId)) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const producto = await getProductoForAdminMedia(connection, productoId);

      if (!producto) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      const tipo = cleanMediaType(req.body.tipo);
      const rol = cleanMediaRole(req.body.rol);
      const secureUrl = cleanString(req.body.secure_url);
      const thumbnailUrl =
        cleanString(req.body.thumbnail_url) || buildThumbnailUrl(secureUrl);
      const cloudinaryPublicId = cleanString(req.body.cloudinary_public_id);
      const orden = parseMediaOrder(req.body.orden, 1);
      const activo = parseTinyBoolean(req.body.activo, 1);

      if (!secureUrl) {
        return res.status(400).json({
          ok: false,
          error: "La URL segura de Cloudinary es obligatoria.",
        });
      }

      await connection.beginTransaction();

      if (tipo === "IMAGEN" && rol === "PRINCIPAL" && activo === 1) {
        await demoteOtherPrincipalMedia(connection, productoId);
      }

      const [insertResult] = await connection.query(
        `
        INSERT INTO producto_multimedia (
          producto_id,
          tipo,
          rol,
          cloudinary_public_id,
          secure_url,
          thumbnail_url,
          codigo_archivo_original,
          nombre_archivo_original,
          orden,
          activo
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          productoId,
          tipo,
          rol,
          cloudinaryPublicId,
          secureUrl,
          thumbnailUrl,
          cleanString(req.body.codigo_archivo_original),
          cleanString(req.body.nombre_archivo_original),
          orden,
          activo,
        ]
      );

      await connection.commit();

      res.status(201).json({
        ok: true,
        message: "Multimedia agregada correctamente.",
        data: {
          id: insertResult.insertId,
          producto_id: productoId,
          tipo,
          rol,
          cloudinary_public_id: cloudinaryPublicId,
          secure_url: secureUrl,
          thumbnail_url: thumbnailUrl,
          orden,
          activo,
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

router.patch("/admin/productos/:id/multimedia/:mediaId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const productoId = Number.parseInt(req.params.id, 10);
      const mediaId = Number.parseInt(req.params.mediaId, 10);

      if (!Number.isFinite(productoId) || !Number.isFinite(mediaId)) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const media = await validateMediaBelongsToProduct(
        connection,
        productoId,
        mediaId
      );

      if (!media) {
        return res.status(404).json({
          ok: false,
          error: "Multimedia no encontrada para este producto.",
        });
      }

      const tipo = cleanMediaType(req.body.tipo || "IMAGEN");
      const rol = cleanMediaRole(req.body.rol || media.rol);
      const activo = parseTinyBoolean(req.body.activo, Number(media.activo) === 1 ? 1 : 0);
      const secureUrl = cleanString(req.body.secure_url);
      const thumbnailUrl =
        cleanString(req.body.thumbnail_url) ||
        (secureUrl ? buildThumbnailUrl(secureUrl) : null);

      await connection.beginTransaction();

      if (tipo === "IMAGEN" && rol === "PRINCIPAL" && activo === 1) {
        await demoteOtherPrincipalMedia(connection, productoId, mediaId);
      }

      await connection.query(
        `
        UPDATE producto_multimedia
        SET
          tipo = ?,
          rol = ?,
          cloudinary_public_id = ?,
          secure_url = COALESCE(?, secure_url),
          thumbnail_url = COALESCE(?, thumbnail_url),
          codigo_archivo_original = ?,
          nombre_archivo_original = ?,
          orden = ?,
          activo = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND producto_id = ?
        `,
        [
          tipo,
          rol,
          cleanString(req.body.cloudinary_public_id),
          secureUrl,
          thumbnailUrl,
          cleanString(req.body.codigo_archivo_original),
          cleanString(req.body.nombre_archivo_original),
          parseMediaOrder(req.body.orden, 1),
          activo,
          mediaId,
          productoId,
        ]
      );

      await connection.commit();

      res.json({
        ok: true,
        message: "Multimedia actualizada correctamente.",
      });
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
);

router.delete("/admin/productos/:id/multimedia/:mediaId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = Number.parseInt(req.params.id, 10);
      const mediaId = Number.parseInt(req.params.mediaId, 10);

      if (!Number.isFinite(productoId) || !Number.isFinite(mediaId)) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const [result] = await pool.query(
        `
        UPDATE producto_multimedia
        SET
          activo = 0,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND producto_id = ?
        `,
        [mediaId, productoId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Multimedia no encontrada para este producto.",
        });
      }

      res.json({
        ok: true,
        message: "Multimedia desactivada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

//DELETE PRODUCTO
router.delete("/admin/productos/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const productoId = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(productoId)) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const [result] = await pool.query(
        `
        UPDATE productos
        SET
          activo = 0,
          activo_web = 0,
          visible_catalogo = 0,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [productoId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Producto desactivado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

//ATRIBUTOS
function m63CleanString(value) {
  if (value === undefined || value === null) return null;

  const clean = String(value).trim();

  return clean || null;
}

function m63RequiredString(value) {
  if (value === undefined || value === null) return "";

  return String(value).trim();
}

function m63ParseInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return fallback;

  return parsed;
}

function m63ParseDecimal(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;

  return parsed;
}

function m63ParseTiny(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;

  if (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true"
  ) {
    return 1;
  }

  return 0;
}

function m63NormalizeText(value) {
  if (!value) return null;

  return String(value)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function m63NormalizePartNumber(value) {
  if (!value) return null;

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "") || null;
}

async function m63EnsureProductExists(productoId) {
  const [rows] = await pool.query(
    `
    SELECT id
    FROM productos
    WHERE id = ?
    LIMIT 1
    `,
    [productoId]
  );

  return rows?.[0] || null;
}

async function m63GetOrCreateMarcaCruce(nombreMarca) {
  const nombre = m63RequiredString(nombreMarca);

  if (!nombre) return null;

  const nombreNormalizado = m63NormalizeText(nombre);

  const [existingRows] = await pool.query(
    `
    SELECT id
    FROM marcas_cruce
    WHERE nombre_normalizado = ?
       OR UPPER(TRIM(nombre)) = UPPER(TRIM(?))
    LIMIT 1
    `,
    [nombreNormalizado, nombre]
  );

  if (existingRows.length) {
    return existingRows[0].id;
  }

  const [result] = await pool.query(
    `
    INSERT INTO marcas_cruce (
      nombre,
      nombre_normalizado,
      activo
    )
    VALUES (?, ?, 1)
    `,
    [nombre, nombreNormalizado]
  );

  return result.insertId;
}

router.post("/admin/productos/:id/atributos",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);

      if (!productoId) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const producto = await m63EnsureProductExists(productoId);

      if (!producto) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      const atributo = m63RequiredString(req.body.atributo);
      const valorTexto = m63RequiredString(req.body.valor_texto);

      if (!atributo || !valorTexto) {
        return res.status(400).json({
          ok: false,
          error: "Atributo y valor son obligatorios.",
        });
      }

      const [result] = await pool.query(
        `
        INSERT INTO producto_atributos (
          producto_id,
          atributo,
          atributo_normalizado,
          valor_texto,
          valor_normalizado,
          valor_numero,
          unidad,
          visible_web,
          buscable,
          orden
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          productoId,
          atributo,
          m63NormalizeText(atributo),
          valorTexto,
          m63NormalizeText(valorTexto),
          m63ParseDecimal(req.body.valor_numero, null),
          m63CleanString(req.body.unidad),
          m63ParseTiny(req.body.visible_web, 1),
          m63ParseTiny(req.body.buscable, 1),
          m63ParseInt(req.body.orden, 0),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Atributo creado correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch("/admin/productos/:id/atributos/:atributoId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);
      const atributoId = m63ParseInt(req.params.atributoId);

      if (!productoId || !atributoId) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const atributo = m63RequiredString(req.body.atributo);
      const valorTexto = m63RequiredString(req.body.valor_texto);

      if (!atributo || !valorTexto) {
        return res.status(400).json({
          ok: false,
          error: "Atributo y valor son obligatorios.",
        });
      }

      const [result] = await pool.query(
        `
        UPDATE producto_atributos
        SET
          atributo = ?,
          atributo_normalizado = ?,
          valor_texto = ?,
          valor_normalizado = ?,
          valor_numero = ?,
          unidad = ?,
          visible_web = ?,
          buscable = ?,
          orden = ?
        WHERE id = ?
          AND producto_id = ?
        `,
        [
          atributo,
          m63NormalizeText(atributo),
          valorTexto,
          m63NormalizeText(valorTexto),
          m63ParseDecimal(req.body.valor_numero, null),
          m63CleanString(req.body.unidad),
          m63ParseTiny(req.body.visible_web, 1),
          m63ParseTiny(req.body.buscable, 1),
          m63ParseInt(req.body.orden, 0),
          atributoId,
          productoId,
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Atributo no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Atributo actualizado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

router.delete("/admin/productos/:id/atributos/:atributoId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);
      const atributoId = m63ParseInt(req.params.atributoId);

      if (!productoId || !atributoId) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const [result] = await pool.query(
        `
        DELETE FROM producto_atributos
        WHERE id = ?
          AND producto_id = ?
        `,
        [atributoId, productoId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Atributo no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Atributo eliminado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

//cruces
router.post("/admin/productos/:id/cruces",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);

      if (!productoId) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const producto = await m63EnsureProductExists(productoId);

      if (!producto) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      const marcaNombre = m63RequiredString(req.body.marca);
      const numeroParte = m63RequiredString(req.body.numero_parte);

      if (!marcaNombre || !numeroParte) {
        return res.status(400).json({
          ok: false,
          error: "Marca y número de parte son obligatorios.",
        });
      }

      const marcaId = await m63GetOrCreateMarcaCruce(marcaNombre);

      const [result] = await pool.query(
        `
        INSERT INTO producto_cruces (
          producto_id,
          marca_id,
          numero_parte,
          numero_parte_normalizado
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          productoId,
          marcaId,
          numeroParte,
          m63NormalizePartNumber(numeroParte),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Cruce creado correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ese cruce ya existe para el producto.",
        });
      }

      next(error);
    }
  }
);

router.patch("/admin/productos/:id/cruces/:cruceId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);
      const cruceId = m63ParseInt(req.params.cruceId);

      if (!productoId || !cruceId) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const marcaNombre = m63RequiredString(req.body.marca);
      const numeroParte = m63RequiredString(req.body.numero_parte);

      if (!marcaNombre || !numeroParte) {
        return res.status(400).json({
          ok: false,
          error: "Marca y número de parte son obligatorios.",
        });
      }

      const marcaId = await m63GetOrCreateMarcaCruce(marcaNombre);

      const [result] = await pool.query(
        `
        UPDATE producto_cruces
        SET
          marca_id = ?,
          numero_parte = ?,
          numero_parte_normalizado = ?
        WHERE id = ?
          AND producto_id = ?
        `,
        [
          marcaId,
          numeroParte,
          m63NormalizePartNumber(numeroParte),
          cruceId,
          productoId,
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Cruce no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Cruce actualizado correctamente.",
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ese cruce ya existe para el producto.",
        });
      }

      next(error);
    }
  }
);

router.delete("/admin/productos/:id/cruces/:cruceId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);
      const cruceId = m63ParseInt(req.params.cruceId);

      if (!productoId || !cruceId) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const [result] = await pool.query(
        `
        DELETE FROM producto_cruces
        WHERE id = ?
          AND producto_id = ?
        `,
        [cruceId, productoId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Cruce no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Cruce eliminado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

//APLICACIONES
router.post("/admin/productos/:id/aplicaciones",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);

      if (!productoId) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const producto = await m63EnsureProductExists(productoId);

      if (!producto) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      const marcaAuto = m63RequiredString(req.body.marca_auto);
      const modeloAuto = m63RequiredString(req.body.modelo_auto);

      if (!marcaAuto || !modeloAuto) {
        return res.status(400).json({
          ok: false,
          error: "Marca y modelo del vehículo son obligatorios.",
        });
      }

      const anioInicio = m63ParseInt(req.body.anio_inicio, null);
      const anioFin = m63ParseInt(req.body.anio_fin, null);

      if (anioInicio && anioFin && anioInicio > anioFin) {
        return res.status(400).json({
          ok: false,
          error: "El año inicio no puede ser mayor al año fin.",
        });
      }

      const motorData = buildApplicationMotorFromPayload(req.body);

      const [result] = await pool.query(
        `
        INSERT INTO producto_aplicaciones (
          producto_id,
          marca_auto,
          modelo_auto,
          motor,
          cilindraje,
          motor_detalle,
          motor_original,
          anio_inicio,
          anio_fin,
          version_auto,
          fuente,
          confianza_extraccion,
          notas
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          productoId,
          marcaAuto,
          modeloAuto,
          motorData.motor,
          motorData.cilindraje,
          motorData.motor_detalle,
          motorData.motor_original,
          anioInicio,
          anioFin,
          m63CleanString(req.body.version_auto),
          m63CleanString(req.body.fuente) || "MANUAL_ADMIN",
          m63ParseDecimal(req.body.confianza_extraccion, 1),
          m63CleanString(req.body.notas),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Aplicación creada correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch("/admin/productos/:id/aplicaciones/:aplicacionId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);
      const aplicacionId = m63ParseInt(req.params.aplicacionId);

      if (!productoId || !aplicacionId) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const marcaAuto = m63RequiredString(req.body.marca_auto);
      const modeloAuto = m63RequiredString(req.body.modelo_auto);

      if (!marcaAuto || !modeloAuto) {
        return res.status(400).json({
          ok: false,
          error: "Marca y modelo del vehículo son obligatorios.",
        });
      }

      const anioInicio = m63ParseInt(req.body.anio_inicio, null);
      const anioFin = m63ParseInt(req.body.anio_fin, null);

      if (anioInicio && anioFin && anioInicio > anioFin) {
        return res.status(400).json({
          ok: false,
          error: "El año inicio no puede ser mayor al año fin.",
        });
      }

      const motorData = buildApplicationMotorFromPayload(req.body);

      const [result] = await pool.query(
        `
        UPDATE producto_aplicaciones
        SET
          marca_auto = ?,
          modelo_auto = ?,
          motor = ?,
          cilindraje = COALESCE(?, cilindraje),
          motor_detalle = COALESCE(?, motor_detalle),
          motor_original = COALESCE(?, motor_original),
          anio_inicio = ?,
          anio_fin = ?,
          version_auto = ?,
          fuente = ?,
          confianza_extraccion = ?,
          notas = ?
        WHERE id = ?
          AND producto_id = ?
        `,
        [
          marcaAuto,
          modeloAuto,
          motorData.motor,
          motorData.cilindraje,
          motorData.motor_detalle,
          motorData.motor_original,
          anioInicio,
          anioFin,
          m63CleanString(req.body.version_auto),
          m63CleanString(req.body.fuente) || "MANUAL_ADMIN",
          m63ParseDecimal(req.body.confianza_extraccion, 1),
          m63CleanString(req.body.notas),
          aplicacionId,
          productoId,
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Aplicación no encontrada.",
        });
      }

      res.json({
        ok: true,
        message: "Aplicación actualizada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

router.delete("/admin/productos/:id/aplicaciones/:aplicacionId",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = m63ParseInt(req.params.id);
      const aplicacionId = m63ParseInt(req.params.aplicacionId);

      if (!productoId || !aplicacionId) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const [result] = await pool.query(
        `
        DELETE FROM producto_aplicaciones
        WHERE id = ?
          AND producto_id = ?
        `,
        [aplicacionId, productoId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Aplicación no encontrada.",
        });
      }

      res.json({
        ok: true,
        message: "Aplicación eliminada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

//ACCIONES RAPIDAS
router.patch("/admin/productos/:id/acciones-rapidas",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const productoId = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(productoId)) {
        return res.status(400).json({
          ok: false,
          error: "ID de producto inválido.",
        });
      }

      const allowedFields = [
        "activo_web",
        "visible_catalogo",
        "destacado",
        "nuevo_web",
      ];

      const updates = [];
      const params = [];

      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          const value = m64ParseTiny(req.body[field], null);

          if (value === null) {
            return res.status(400).json({
              ok: false,
              error: `Valor inválido para ${field}.`,
            });
          }

          updates.push(`${field} = ?`);
          params.push(value);
        }
      }

      if (!updates.length) {
        return res.status(400).json({
          ok: false,
          error: "No hay cambios válidos para aplicar.",
        });
      }

      params.push(productoId);

      const [result] = await pool.query(
        `
        UPDATE productos
        SET
          ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Acción rápida aplicada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

//Upload

function siteSafeCloudinarySegment(value, fallback = "item") {
  const clean = String(value || fallback)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return clean || fallback;
}

function buildSiteMediaPublicId({ target, key, fileName }) {
  const safeTarget = siteSafeCloudinarySegment(target, "contenido");
  const safeKey = siteSafeCloudinarySegment(key, "sin_clave");

  const safeFile = siteSafeCloudinarySegment(
    String(fileName || "imagen").replace(/\.[^.]+$/, ""),
    "imagen"
  );

  return `andyfers/contenido/${safeTarget}/${safeKey}/${Date.now()}_${safeFile}`;
}

router.post("/admin/site/media/upload",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "La imagen es obligatoria.",
        });
      }

      const target = cleanString(req.body.target) || "contenido";
      const key = cleanString(req.body.key) || "sin_clave";
      const field = cleanString(req.body.field) || "media_url";

      const publicId = buildSiteMediaPublicId({
        target,
        key,
        fileName: req.file.originalname,
      });

      const uploadResponse = await uploadBufferToCloudinary(req.file.buffer, {
        public_id: publicId,
        resource_type: "image",
        overwrite: false,
        unique_filename: false,
        folder: undefined,
        tags: [
          "andyfers",
          "contenido",
          siteSafeCloudinarySegment(target, "contenido"),
          siteSafeCloudinarySegment(field, "media"),
        ],
      });

      const secureUrl = uploadResponse.secure_url;
      const thumbnailUrl = buildThumbnailUrl(secureUrl);

      res.status(201).json({
        ok: true,
        message: "Imagen subida correctamente.",
        data: {
          cloudinary_public_id: uploadResponse.public_id,
          secure_url: secureUrl,
          thumbnail_url: thumbnailUrl,
          field,
          target,
          key,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/* ADMIN CONTENIDO EDITABLE */

function siteParseNullableInt(value) {
  if (value === undefined || value === null || value === "") return null;

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : null;
}

function siteParseOrder(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function siteParseLimit(value, fallback = 8) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return fallback;

  return Math.min(parsed, 60);
}

function siteJsonToDb(value) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  const clean = String(value).trim();

  if (!clean) return null;

  try {
    JSON.parse(clean);
    return clean;
  } catch {
    return JSON.stringify({
      raw: clean,
    });
  }
}

function siteParseJsonSafe(value, fallback = {}) {
  if (!value) return fallback;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function siteCleanRow(row) {
  const next = {
    ...row,
    metadata: siteParseJsonSafe(row.metadata_json, {}),
  };

  delete next.metadata_json;

  return next;
}

function siteHasOwn(body, field) {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function sitePushUpdate(updates, params, body, field, column = field, transform = cleanString) {
  if (!siteHasOwn(body, field)) return;

  updates.push(`${column} = ?`);
  params.push(transform(body[field]));
}

function siteBuildSimpleWhere(query = {}, config = {}) {
  const conditions = [];
  const params = [];

  const q = cleanString(query.q);
  const pagina = cleanString(query.pagina);
  const bloque = cleanString(query.bloque);
  const tipo = cleanString(query.tipo);
  const posicion = cleanString(query.posicion);
  const activo = parseBooleanFlag(query.activo, null);

  if (activo !== null) {
    conditions.push("activo = ?");
    params.push(activo);
  }

  if (pagina && config.pagina) {
    conditions.push(`${config.pagina} = ?`);
    params.push(pagina.toUpperCase());
  }

  if (bloque && config.bloque) {
    conditions.push(`${config.bloque} = ?`);
    params.push(bloque.toUpperCase());
  }

  if (tipo && config.tipo) {
    conditions.push(`${config.tipo} = ?`);
    params.push(tipo.toUpperCase());
  }

  if (posicion && config.posicion) {
    conditions.push(`${config.posicion} = ?`);
    params.push(posicion.toUpperCase());
  }

  if (q && Array.isArray(config.qColumns) && config.qColumns.length) {
    const like = `%${q}%`;

    conditions.push(
      `(${config.qColumns.map((column) => `${column} LIKE ?`).join(" OR ")})`
    );

    config.qColumns.forEach(() => params.push(like));
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/* CONTENT BLOCKS */

router.get("/admin/site/content-blocks", requireAdminAuth, async (req, res, next) => {
  try {
    const { whereSql, params } = siteBuildSimpleWhere(req.query, {
      pagina: "pagina",
      bloque: "bloque",
      tipo: "tipo",
      qColumns: [
        "content_key",
        "pagina",
        "bloque",
        "etiqueta",
        "titulo",
        "subtitulo",
        "contenido",
      ],
    });

    const [rows] = await pool.query(
      `
      SELECT
        id,
        content_key,
        pagina,
        bloque,
        tipo,
        etiqueta,
        titulo,
        subtitulo,
        contenido,
        cta_texto,
        cta_url,
        media_tipo,
        media_url,
        media_public_id,
        metadata_json,
        orden,
        activo,
        created_at,
        updated_at
      FROM site_content_blocks
      ${whereSql}
      ORDER BY pagina ASC, bloque ASC, orden ASC, id ASC
      `,
      params
    );

    res.json({
      ok: true,
      data: rows.map(siteCleanRow),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/site/content-blocks",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const contentKey = cleanString(req.body.content_key);

      if (!contentKey) {
        return res.status(400).json({
          ok: false,
          error: "content_key es obligatorio.",
        });
      }

      const [result] = await pool.query(
        `
        INSERT INTO site_content_blocks (
          content_key,
          pagina,
          bloque,
          tipo,
          etiqueta,
          titulo,
          subtitulo,
          contenido,
          cta_texto,
          cta_url,
          media_tipo,
          media_url,
          media_public_id,
          metadata_json,
          orden,
          activo
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          contentKey,
          cleanString(req.body.pagina) || "GLOBAL",
          cleanString(req.body.bloque) || "GENERAL",
          cleanString(req.body.tipo) || "TEXTO",
          cleanString(req.body.etiqueta),
          cleanString(req.body.titulo),
          cleanString(req.body.subtitulo),
          cleanString(req.body.contenido),
          cleanString(req.body.cta_texto),
          cleanString(req.body.cta_url),
          cleanString(req.body.media_tipo),
          cleanString(req.body.media_url),
          cleanString(req.body.media_public_id),
          siteJsonToDb(req.body.metadata || req.body.metadata_json),
          siteParseOrder(req.body.orden, 0),
          parseBooleanFlag(req.body.activo, 1),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Bloque de contenido creado correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe un bloque con ese content_key.",
        });
      }

      next(error);
    }
  }
);

router.patch("/admin/site/content-blocks/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      if (!Number.isFinite(id)) {
        return res.status(400).json({
          ok: false,
          error: "ID inválido.",
        });
      }

      const updates = [];
      const params = [];

      sitePushUpdate(updates, params, req.body, "content_key");
      sitePushUpdate(updates, params, req.body, "pagina");
      sitePushUpdate(updates, params, req.body, "bloque");
      sitePushUpdate(updates, params, req.body, "tipo");
      sitePushUpdate(updates, params, req.body, "etiqueta");
      sitePushUpdate(updates, params, req.body, "titulo");
      sitePushUpdate(updates, params, req.body, "subtitulo");
      sitePushUpdate(updates, params, req.body, "contenido");
      sitePushUpdate(updates, params, req.body, "cta_texto");
      sitePushUpdate(updates, params, req.body, "cta_url");
      sitePushUpdate(updates, params, req.body, "media_tipo");
      sitePushUpdate(updates, params, req.body, "media_url");
      sitePushUpdate(updates, params, req.body, "media_public_id");

      if (siteHasOwn(req.body, "metadata") || siteHasOwn(req.body, "metadata_json")) {
        updates.push("metadata_json = ?");
        params.push(siteJsonToDb(req.body.metadata || req.body.metadata_json));
      }

      if (siteHasOwn(req.body, "orden")) {
        updates.push("orden = ?");
        params.push(siteParseOrder(req.body.orden, 0));
      }

      if (siteHasOwn(req.body, "activo")) {
        updates.push("activo = ?");
        params.push(parseBooleanFlag(req.body.activo, 1));
      }

      if (!updates.length) {
        return res.status(400).json({
          ok: false,
          error: "No hay cambios válidos.",
        });
      }

      params.push(id);

      const [result] = await pool.query(
        `
        UPDATE site_content_blocks
        SET
          ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Bloque no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Bloque de contenido actualizado correctamente.",
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe un bloque con ese content_key.",
        });
      }

      next(error);
    }
  }
);

router.delete("/admin/site/content-blocks/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const [result] = await pool.query(
        `
        UPDATE site_content_blocks
        SET activo = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Bloque no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Bloque desactivado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

/* BANNERS */

router.get("/admin/site/banners", requireAdminAuth, async (req, res, next) => {
  try {
    const { whereSql, params } = siteBuildSimpleWhere(req.query, {
      pagina: "pagina",
      posicion: "posicion",
      qColumns: [
        "banner_key",
        "pagina",
        "posicion",
        "titulo",
        "subtitulo",
        "descripcion",
      ],
    });

    const [rows] = await pool.query(
      `
      SELECT
        id,
        banner_key,
        pagina,
        posicion,
        titulo,
        subtitulo,
        descripcion,
        texto_boton,
        url_boton,
        media_tipo,
        media_url,
        thumbnail_url,
        cloudinary_public_id,
        color_fondo,
        color_texto,
        fecha_inicio,
        fecha_fin,
        orden,
        activo,
        created_at,
        updated_at
      FROM site_banners
      ${whereSql}
      ORDER BY pagina ASC, posicion ASC, orden ASC, id ASC
      `,
      params
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/site/banners",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const bannerKey = cleanString(req.body.banner_key);

      if (!bannerKey) {
        return res.status(400).json({
          ok: false,
          error: "banner_key es obligatorio.",
        });
      }

      const [result] = await pool.query(
        `
        INSERT INTO site_banners (
          banner_key,
          pagina,
          posicion,
          titulo,
          subtitulo,
          descripcion,
          texto_boton,
          url_boton,
          media_tipo,
          media_url,
          thumbnail_url,
          cloudinary_public_id,
          color_fondo,
          color_texto,
          fecha_inicio,
          fecha_fin,
          orden,
          activo
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          bannerKey,
          cleanString(req.body.pagina) || "GLOBAL",
          cleanString(req.body.posicion) || "GENERAL",
          cleanString(req.body.titulo),
          cleanString(req.body.subtitulo),
          cleanString(req.body.descripcion),
          cleanString(req.body.texto_boton),
          cleanString(req.body.url_boton),
          cleanString(req.body.media_tipo) || "IMAGEN",
          cleanString(req.body.media_url),
          cleanString(req.body.thumbnail_url),
          cleanString(req.body.cloudinary_public_id),
          cleanString(req.body.color_fondo),
          cleanString(req.body.color_texto),
          cleanDateTime(req.body.fecha_inicio),
          cleanDateTime(req.body.fecha_fin),
          siteParseOrder(req.body.orden, 0),
          parseBooleanFlag(req.body.activo, 1),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Banner creado correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe un banner con ese banner_key.",
        });
      }

      next(error);
    }
  }
);

router.patch("/admin/site/banners/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const updates = [];
      const params = [];

      sitePushUpdate(updates, params, req.body, "banner_key");
      sitePushUpdate(updates, params, req.body, "pagina");
      sitePushUpdate(updates, params, req.body, "posicion");
      sitePushUpdate(updates, params, req.body, "titulo");
      sitePushUpdate(updates, params, req.body, "subtitulo");
      sitePushUpdate(updates, params, req.body, "descripcion");
      sitePushUpdate(updates, params, req.body, "texto_boton");
      sitePushUpdate(updates, params, req.body, "url_boton");
      sitePushUpdate(updates, params, req.body, "media_tipo");
      sitePushUpdate(updates, params, req.body, "media_url");
      sitePushUpdate(updates, params, req.body, "thumbnail_url");
      sitePushUpdate(updates, params, req.body, "cloudinary_public_id");
      sitePushUpdate(updates, params, req.body, "color_fondo");
      sitePushUpdate(updates, params, req.body, "color_texto");

      if (siteHasOwn(req.body, "fecha_inicio")) {
        updates.push("fecha_inicio = ?");
        params.push(cleanDateTime(req.body.fecha_inicio));
      }

      if (siteHasOwn(req.body, "fecha_fin")) {
        updates.push("fecha_fin = ?");
        params.push(cleanDateTime(req.body.fecha_fin));
      }

      if (siteHasOwn(req.body, "orden")) {
        updates.push("orden = ?");
        params.push(siteParseOrder(req.body.orden, 0));
      }

      if (siteHasOwn(req.body, "activo")) {
        updates.push("activo = ?");
        params.push(parseBooleanFlag(req.body.activo, 1));
      }

      if (!updates.length) {
        return res.status(400).json({
          ok: false,
          error: "No hay cambios válidos.",
        });
      }

      params.push(id);

      const [result] = await pool.query(
        `
        UPDATE site_banners
        SET
          ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Banner no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Banner actualizado correctamente.",
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe un banner con ese banner_key.",
        });
      }

      next(error);
    }
  }
);

router.delete("/admin/site/banners/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const [result] = await pool.query(
        `
        UPDATE site_banners
        SET activo = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Banner no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Banner desactivado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

/* LINEAS COMERCIALES */

router.get("/admin/site/lineas-comerciales", requireAdminAuth, async (req, res, next) => {
  try {
    const { whereSql, params } = siteBuildSimpleWhere(req.query, {
      qColumns: [
        "line_key",
        "nombre",
        "slug",
        "descripcion_corta",
        "descripcion_larga",
      ],
    });

    const [rows] = await pool.query(
      `
      SELECT
        id,
        line_key,
        nombre,
        slug,
        descripcion_corta,
        descripcion_larga,
        icono,
        color,
        imagen_url,
        thumbnail_url,
        cloudinary_public_id,
        url_destino,
        visible_home,
        orden,
        activo,
        created_at,
        updated_at
      FROM site_commercial_lines
      ${whereSql}
      ORDER BY activo DESC, orden ASC, id ASC
      `,
      params
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/site/lineas-comerciales",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const lineKey = cleanString(req.body.line_key);
      const nombre = cleanString(req.body.nombre);

      if (!lineKey || !nombre) {
        return res.status(400).json({
          ok: false,
          error: "line_key y nombre son obligatorios.",
        });
      }

      const [result] = await pool.query(
        `
        INSERT INTO site_commercial_lines (
          line_key,
          nombre,
          slug,
          descripcion_corta,
          descripcion_larga,
          icono,
          color,
          imagen_url,
          thumbnail_url,
          cloudinary_public_id,
          url_destino,
          visible_home,
          orden,
          activo
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          lineKey,
          nombre,
          cleanString(req.body.slug),
          cleanString(req.body.descripcion_corta),
          cleanString(req.body.descripcion_larga),
          cleanString(req.body.icono),
          cleanString(req.body.color),
          cleanString(req.body.imagen_url),
          cleanString(req.body.thumbnail_url),
          cleanString(req.body.cloudinary_public_id),
          cleanString(req.body.url_destino),
          parseBooleanFlag(req.body.visible_home, 1),
          siteParseOrder(req.body.orden, 0),
          parseBooleanFlag(req.body.activo, 1),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Línea comercial creada correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe una línea comercial con esa clave o slug.",
        });
      }

      next(error);
    }
  }
);

router.patch("/admin/site/lineas-comerciales/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const updates = [];
      const params = [];

      sitePushUpdate(updates, params, req.body, "line_key");
      sitePushUpdate(updates, params, req.body, "nombre");
      sitePushUpdate(updates, params, req.body, "slug");
      sitePushUpdate(updates, params, req.body, "descripcion_corta");
      sitePushUpdate(updates, params, req.body, "descripcion_larga");
      sitePushUpdate(updates, params, req.body, "icono");
      sitePushUpdate(updates, params, req.body, "color");
      sitePushUpdate(updates, params, req.body, "imagen_url");
      sitePushUpdate(updates, params, req.body, "thumbnail_url");
      sitePushUpdate(updates, params, req.body, "cloudinary_public_id");
      sitePushUpdate(updates, params, req.body, "url_destino");

      if (siteHasOwn(req.body, "visible_home")) {
        updates.push("visible_home = ?");
        params.push(parseBooleanFlag(req.body.visible_home, 1));
      }

      if (siteHasOwn(req.body, "orden")) {
        updates.push("orden = ?");
        params.push(siteParseOrder(req.body.orden, 0));
      }

      if (siteHasOwn(req.body, "activo")) {
        updates.push("activo = ?");
        params.push(parseBooleanFlag(req.body.activo, 1));
      }

      if (!updates.length) {
        return res.status(400).json({
          ok: false,
          error: "No hay cambios válidos.",
        });
      }

      params.push(id);

      const [result] = await pool.query(
        `
        UPDATE site_commercial_lines
        SET
          ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Línea comercial no encontrada.",
        });
      }

      res.json({
        ok: true,
        message: "Línea comercial actualizada correctamente.",
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe una línea comercial con esa clave o slug.",
        });
      }

      next(error);
    }
  }
);

router.delete("/admin/site/lineas-comerciales/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const [result] = await pool.query(
        `
        UPDATE site_commercial_lines
        SET activo = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Línea comercial no encontrada.",
        });
      }

      res.json({
        ok: true,
        message: "Línea comercial desactivada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

/* SECCIONES DESTACADAS */

router.get("/admin/site/secciones-destacadas", requireAdminAuth, async (req, res, next) => {
  try {
    const { whereSql, params } = siteBuildSimpleWhere(req.query, {
      pagina: "pagina",
      qColumns: [
        "section_key",
        "pagina",
        "titulo",
        "subtitulo",
        "descripcion",
        "layout",
        "source_type",
        "filtro_familia",
      ],
    });

    const [rows] = await pool.query(
      `
      SELECT
        id,
        section_key,
        pagina,
        titulo,
        subtitulo,
        descripcion,
        layout,
        source_type,
        filtro_familia,
        filtro_categoria_id,
        limite_productos,
        cta_texto,
        cta_url,
        metadata_json,
        orden,
        activo,
        created_at,
        updated_at
      FROM site_featured_sections
      ${whereSql}
      ORDER BY pagina ASC, orden ASC, id ASC
      `,
      params
    );

    res.json({
      ok: true,
      data: rows.map(siteCleanRow),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/site/secciones-destacadas",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const sectionKey = cleanString(req.body.section_key);
      const titulo = cleanString(req.body.titulo);

      if (!sectionKey || !titulo) {
        return res.status(400).json({
          ok: false,
          error: "section_key y titulo son obligatorios.",
        });
      }

      const [result] = await pool.query(
        `
        INSERT INTO site_featured_sections (
          section_key,
          pagina,
          titulo,
          subtitulo,
          descripcion,
          layout,
          source_type,
          filtro_familia,
          filtro_categoria_id,
          limite_productos,
          cta_texto,
          cta_url,
          metadata_json,
          orden,
          activo
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          sectionKey,
          cleanString(req.body.pagina) || "HOME",
          titulo,
          cleanString(req.body.subtitulo),
          cleanString(req.body.descripcion),
          cleanString(req.body.layout) || "GRID",
          cleanString(req.body.source_type) || "MANUAL",
          cleanString(req.body.filtro_familia),
          siteParseNullableInt(req.body.filtro_categoria_id),
          siteParseLimit(req.body.limite_productos, 8),
          cleanString(req.body.cta_texto),
          cleanString(req.body.cta_url),
          siteJsonToDb(req.body.metadata || req.body.metadata_json),
          siteParseOrder(req.body.orden, 0),
          parseBooleanFlag(req.body.activo, 1),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Sección destacada creada correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe una sección con ese section_key.",
        });
      }

      next(error);
    }
  }
);

router.patch("/admin/site/secciones-destacadas/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const updates = [];
      const params = [];

      sitePushUpdate(updates, params, req.body, "section_key");
      sitePushUpdate(updates, params, req.body, "pagina");
      sitePushUpdate(updates, params, req.body, "titulo");
      sitePushUpdate(updates, params, req.body, "subtitulo");
      sitePushUpdate(updates, params, req.body, "descripcion");
      sitePushUpdate(updates, params, req.body, "layout");
      sitePushUpdate(updates, params, req.body, "source_type");
      sitePushUpdate(updates, params, req.body, "filtro_familia");
      sitePushUpdate(updates, params, req.body, "cta_texto");
      sitePushUpdate(updates, params, req.body, "cta_url");

      if (siteHasOwn(req.body, "filtro_categoria_id")) {
        updates.push("filtro_categoria_id = ?");
        params.push(siteParseNullableInt(req.body.filtro_categoria_id));
      }

      if (siteHasOwn(req.body, "limite_productos")) {
        updates.push("limite_productos = ?");
        params.push(siteParseLimit(req.body.limite_productos, 8));
      }

      if (siteHasOwn(req.body, "metadata") || siteHasOwn(req.body, "metadata_json")) {
        updates.push("metadata_json = ?");
        params.push(siteJsonToDb(req.body.metadata || req.body.metadata_json));
      }

      if (siteHasOwn(req.body, "orden")) {
        updates.push("orden = ?");
        params.push(siteParseOrder(req.body.orden, 0));
      }

      if (siteHasOwn(req.body, "activo")) {
        updates.push("activo = ?");
        params.push(parseBooleanFlag(req.body.activo, 1));
      }

      if (!updates.length) {
        return res.status(400).json({
          ok: false,
          error: "No hay cambios válidos.",
        });
      }

      params.push(id);

      const [result] = await pool.query(
        `
        UPDATE site_featured_sections
        SET
          ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Sección destacada no encontrada.",
        });
      }

      res.json({
        ok: true,
        message: "Sección destacada actualizada correctamente.",
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe una sección con ese section_key.",
        });
      }

      next(error);
    }
  }
);

router.delete("/admin/site/secciones-destacadas/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const [result] = await pool.query(
        `
        UPDATE site_featured_sections
        SET activo = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Sección destacada no encontrada.",
        });
      }

      res.json({
        ok: true,
        message: "Sección destacada desactivada correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

/* CONTACTO / WHATSAPP */

router.get("/admin/site/contacto", requireAdminAuth, async (req, res, next) => {
  try {
    const { whereSql, params } = siteBuildSimpleWhere(req.query, {
      tipo: "tipo",
      qColumns: [
        "channel_key",
        "tipo",
        "etiqueta",
        "valor",
        "url",
        "descripcion",
      ],
    });

    const [rows] = await pool.query(
      `
      SELECT
        id,
        channel_key,
        tipo,
        etiqueta,
        valor,
        url,
        icono,
        descripcion,
        metadata_json,
        orden,
        activo,
        created_at,
        updated_at
      FROM site_contact_channels
      ${whereSql}
      ORDER BY activo DESC, orden ASC, id ASC
      `,
      params
    );

    res.json({
      ok: true,
      data: rows.map(siteCleanRow),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/site/contacto",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const channelKey = cleanString(req.body.channel_key);
      const tipo = cleanString(req.body.tipo);
      const etiqueta = cleanString(req.body.etiqueta);

      if (!channelKey || !tipo || !etiqueta) {
        return res.status(400).json({
          ok: false,
          error: "channel_key, tipo y etiqueta son obligatorios.",
        });
      }

      const [result] = await pool.query(
        `
        INSERT INTO site_contact_channels (
          channel_key,
          tipo,
          etiqueta,
          valor,
          url,
          icono,
          descripcion,
          metadata_json,
          orden,
          activo
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          channelKey,
          tipo,
          etiqueta,
          cleanString(req.body.valor),
          cleanString(req.body.url),
          cleanString(req.body.icono),
          cleanString(req.body.descripcion),
          siteJsonToDb(req.body.metadata || req.body.metadata_json),
          siteParseOrder(req.body.orden, 0),
          parseBooleanFlag(req.body.activo, 1),
        ]
      );

      res.status(201).json({
        ok: true,
        message: "Canal de contacto creado correctamente.",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe un canal con ese channel_key.",
        });
      }

      next(error);
    }
  }
);

router.patch("/admin/site/contacto/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const updates = [];
      const params = [];

      sitePushUpdate(updates, params, req.body, "channel_key");
      sitePushUpdate(updates, params, req.body, "tipo");
      sitePushUpdate(updates, params, req.body, "etiqueta");
      sitePushUpdate(updates, params, req.body, "valor");
      sitePushUpdate(updates, params, req.body, "url");
      sitePushUpdate(updates, params, req.body, "icono");
      sitePushUpdate(updates, params, req.body, "descripcion");

      if (siteHasOwn(req.body, "metadata") || siteHasOwn(req.body, "metadata_json")) {
        updates.push("metadata_json = ?");
        params.push(siteJsonToDb(req.body.metadata || req.body.metadata_json));
      }

      if (siteHasOwn(req.body, "orden")) {
        updates.push("orden = ?");
        params.push(siteParseOrder(req.body.orden, 0));
      }

      if (siteHasOwn(req.body, "activo")) {
        updates.push("activo = ?");
        params.push(parseBooleanFlag(req.body.activo, 1));
      }

      if (!updates.length) {
        return res.status(400).json({
          ok: false,
          error: "No hay cambios válidos.",
        });
      }

      params.push(id);

      const [result] = await pool.query(
        `
        UPDATE site_contact_channels
        SET
          ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Canal de contacto no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Canal de contacto actualizado correctamente.",
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          ok: false,
          error: "Ya existe un canal con ese channel_key.",
        });
      }

      next(error);
    }
  }
);

router.delete("/admin/site/contacto/:id",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);

      const [result] = await pool.query(
        `
        UPDATE site_contact_channels
        SET activo = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          ok: false,
          error: "Canal de contacto no encontrado.",
        });
      }

      res.json({
        ok: true,
        message: "Canal de contacto desactivado correctamente.",
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;