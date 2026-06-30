import crypto from "crypto";
import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();

const adminChatAccess = [
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS", "SOPORTE"]),
];

const INTENCIONES = [
  "COTIZACION",
  "DUDA_PRODUCTO",
  "COMPATIBILIDAD",
  "EXISTENCIA_PRECIO",
  "ENVIO",
  "SEGUIMIENTO_PEDIDO",
  "OTRO",
];

function cleanString(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function createPublicToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeProductCode(value) {
  const clean = cleanString(value, 120);

  if (!clean) return "";

  const invalid = new Set([
    "#N/A",
    "N/A",
    "NA",
    "ND",
    "N.D.",
    "SIN CODIGO",
    "SIN CÓDIGO",
    "NULL",
    "0",
  ]);

  if (invalid.has(clean.toUpperCase())) return "";

  return clean;
}

function validateWhatsappOrThrow(whatsapp) {
  const clean = normalizePhone(whatsapp);

  if (!clean) {
    const error = new Error("El WhatsApp es obligatorio.");
    error.status = 400;
    throw error;
  }

  if (clean.length < 10 || clean.length > 15) {
    const error = new Error("El WhatsApp debe tener entre 10 y 15 dígitos.");
    error.status = 400;
    throw error;
  }

  return clean;
}

function normalizeEstado(value) {
  const estado = cleanString(value, 40).toUpperCase();
  const allowed = ["ABIERTO", "ATENDIENDO", "CERRADO"];

  return allowed.includes(estado) ? estado : "";
}

function getSafeLimit(value, defaultValue = 80, maxValue = 200) {
  const parsed = Number(value || defaultValue);

  if (!Number.isFinite(parsed)) return defaultValue;

  return Math.min(Math.max(parsed, 1), maxValue);
}

async function logChatEvent(connection, conversationId, tipo, descripcion, metadata = null) {
  try {
    await connection.query(
      `
        INSERT INTO chat_eventos (
          conversacion_id,
          tipo,
          descripcion,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, NOW())
      `,
      [
        conversationId,
        cleanString(tipo, 80),
        cleanString(descripcion, 500),
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch { }
}

function getAdminIdentity(req) {
  const user = req.admin || req.user || {};

  return {
    nombre:
      user.nombre ||
      user.name ||
      user.correo ||
      user.email ||
      "Administrador",
    correo: user.correo || user.email || null,
  };
}

function normalizeIntention(value) {
  const clean = cleanString(value, 40);

  return INTENCIONES.includes(clean) ? clean : "COTIZACION";
}

function mapConversation(row) {
  if (!row) return null;

  return {
    id: row.id,
    public_token: row.public_token,
    cotizacion_id: row.cotizacion_id,
    cotizacion_folio: row.cotizacion_folio,
    pedido_folio: row.pedido_folio,
    producto_codigo: row.producto_codigo,
    tipo_intencion: row.tipo_intencion,
    cliente_nombre: row.cliente_nombre,
    cliente_whatsapp: row.cliente_whatsapp,
    cliente_correo: row.cliente_correo,
    asunto: row.asunto,
    estado: row.estado,
    prioridad: row.prioridad,
    canal: row.canal,
    admin_asignado_correo: row.admin_asignado_correo,
    admin_asignado_nombre: row.admin_asignado_nombre,
    ultimo_mensaje: row.ultimo_mensaje,
    ultimo_emisor: row.ultimo_emisor,
    last_message_at: row.last_message_at,
    last_admin_read_at: row.last_admin_read_at,
    last_cliente_read_at: row.last_cliente_read_at,
    unread_admin: Number(row.unread_admin || 0),
    unread_cliente: Number(row.unread_cliente || 0),
    total_mensajes: Number(row.total_mensajes || 0),
    last_message_id: Number(row.last_message_id || 0),
    cerrado_at: row.cerrado_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getConversationById(id) {
  const [rows] = await pool.query(
    `
      SELECT
        cc.*,
        COUNT(cm.id) AS total_mensajes,
        COALESCE(MAX(cm.id), 0) AS last_message_id
      FROM chat_conversaciones cc
      LEFT JOIN chat_mensajes cm ON cm.conversacion_id = cc.id
      WHERE cc.id = ?
      GROUP BY cc.id
      LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

async function getConversationByToken(token) {
  const [rows] = await pool.query(
    `
      SELECT
        cc.*,
        COUNT(cm.id) AS total_mensajes,
        COALESCE(MAX(cm.id), 0) AS last_message_id
      FROM chat_conversaciones cc
      LEFT JOIN chat_mensajes cm ON cm.conversacion_id = cc.id
      WHERE cc.public_token = ?
      GROUP BY cc.id
      LIMIT 1
    `,
    [token]
  );

  return rows[0] || null;
}

async function getMessages(conversationId, afterId = 0, limit = 120) {
  const safeLimit = getSafeLimit(limit, 120, 250);
  const safeAfterId = Number(afterId || 0);

  const params = [conversationId];
  let afterSql = "";

  if (safeAfterId > 0) {
    afterSql = "AND id > ?";
    params.push(safeAfterId);
  }

  params.push(safeLimit);

  const [rows] = await pool.query(
    `
      SELECT
        id,
        conversacion_id,
        emisor_tipo,
        emisor_nombre,
        emisor_correo,
        mensaje,
        metadata_json,
        leido_admin,
        leido_cliente,
        created_at
      FROM chat_mensajes
      WHERE conversacion_id = ?
        ${afterSql}
      ORDER BY id ASC
      LIMIT ?
    `,
    params
  );

  return rows;
}

async function insertMessage(connection, conversation, messageData) {
  const mensaje = cleanString(messageData.mensaje, 4000);

  if (!mensaje) {
    const error = new Error("El mensaje no puede estar vacío.");
    error.status = 400;
    throw error;
  }

  if (conversation.estado === "CERRADO" && !messageData.allow_closed) {
    const error = new Error(
      "La conversación está cerrada. Para continuar, reábrela o inicia un nuevo chat."
    );
    error.status = 409;
    throw error;
  }

  const emisorTipo = messageData.emisor_tipo;
  const isAdmin = emisorTipo === "ADMIN";
  const isCliente = emisorTipo === "CLIENTE";

  const [messageResult] = await connection.query(
    `
      INSERT INTO chat_mensajes (
        conversacion_id,
        emisor_tipo,
        emisor_nombre,
        emisor_correo,
        mensaje,
        metadata_json,
        leido_admin,
        leido_cliente
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      conversation.id,
      emisorTipo,
      messageData.emisor_nombre || null,
      messageData.emisor_correo || null,
      mensaje,
      messageData.metadata_json || null,
      isAdmin ? 1 : 0,
      isCliente ? 1 : 0,
    ]
  );

  await connection.query(
    `
      UPDATE chat_conversaciones
      SET
        ultimo_mensaje = ?,
        ultimo_emisor = ?,
        last_message_at = NOW(),
        unread_admin = unread_admin + ?,
        unread_cliente = unread_cliente + ?,
        updated_at = NOW()
      WHERE id = ?
    `,
    [
      mensaje,
      emisorTipo,
      isCliente ? 1 : 0,
      isAdmin ? 1 : 0,
      conversation.id,
    ]
  );

  await logChatEvent(connection, conversation.id, "MENSAJE", "Mensaje agregado al chat.", {
    emisor_tipo: emisorTipo,
    message_id: messageResult.insertId,
  });

  return messageResult.insertId;
}

async function findCotizacionByFolio(folio) {
  if (!folio) return null;

  const [rows] = await pool.query(
    `
      SELECT
        id,
        folio,
        nombre_cliente,
        whatsapp,
        correo
      FROM cotizaciones
      WHERE folio = ?
      LIMIT 1
    `,
    [folio]
  );

  return rows[0] || null;
}

async function createConversationFromCotizacion(folio, req) {
  const cleanFolio = cleanString(folio, 80);

  const [existingRows] = await pool.query(
    `
      SELECT *
      FROM chat_conversaciones
      WHERE cotizacion_folio = ?
      LIMIT 1
    `,
    [cleanFolio]
  );

  if (existingRows[0]) return existingRows[0];

  const cotizacion = await findCotizacionByFolio(cleanFolio);

  if (!cotizacion) {
    const error = new Error("Cotización no encontrada.");
    error.status = 404;
    throw error;
  }

  const admin = getAdminIdentity(req);
  const token = createPublicToken();

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      `
        INSERT INTO chat_conversaciones (
          public_token,
          cotizacion_id,
          cotizacion_folio,
          cliente_nombre,
          cliente_whatsapp,
          cliente_correo,
          asunto,
          estado,
          prioridad,
          canal,
          tipo_intencion,
          admin_asignado_correo,
          admin_asignado_nombre,
          ultimo_mensaje,
          ultimo_emisor,
          last_message_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ABIERTO', 'MEDIA', 'COTIZACION', 'COTIZACION', ?, ?, ?, 'SISTEMA', NOW())
      `,
      [
        token,
        cotizacion.id,
        cotizacion.folio,
        cotizacion.nombre_cliente,
        cotizacion.whatsapp,
        cotizacion.correo,
        `Cotización ${cotizacion.folio}`,
        admin.correo,
        admin.nombre,
        "Conversación creada desde cotización.",
      ]
    );

    const conversationId = result.insertId;

    await connection.query(
      `
        INSERT INTO chat_mensajes (
          conversacion_id,
          emisor_tipo,
          emisor_nombre,
          emisor_correo,
          mensaje,
          leido_admin,
          leido_cliente
        )
        VALUES (?, 'SISTEMA', 'Sistema Andyfers', NULL, ?, 1, 0)
      `,
      [conversationId, `Conversación creada para la cotización ${cotizacion.folio}.`]
    );

    await logChatEvent(
      connection,
      conversationId,
      "CREACION_DESDE_COTIZACION",
      `Conversación creada desde cotización ${cotizacion.folio}.`,
      {
        folio: cotizacion.folio,
        admin_correo: admin.correo,
      }
    );

    await connection.commit();

    return await getConversationById(conversationId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

/* ADMIN */
router.get("/admin/chat/conversaciones", adminChatAccess, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const q = cleanString(req.query.q, 120);
    const estado = normalizeEstado(req.query.estado);
    const limit = getSafeLimit(req.query.limit, 40, 100);

    const params = [];
    const where = [];

    if (estado) {
      where.push("cc.estado = ?");
      params.push(estado);
    }

    if (q) {
      const like = `%${q}%`;

      where.push(`
        (
          cc.cotizacion_folio LIKE ?
          OR cc.pedido_folio LIKE ?
          OR cc.producto_codigo LIKE ?
          OR cc.cliente_nombre LIKE ?
          OR cc.cliente_whatsapp LIKE ?
          OR cc.cliente_correo LIKE ?
          OR cc.asunto LIKE ?
          OR cc.ultimo_mensaje LIKE ?
        )
      `);

      params.push(like, like, like, like, like, like, like, like);
    }

    params.push(limit);

    const [rows] = await pool.query(
      `
        SELECT
          cc.*,
          COUNT(cm.id) AS total_mensajes,
          COALESCE(MAX(cm.id), 0) AS last_message_id
        FROM chat_conversaciones cc
        LEFT JOIN chat_mensajes cm ON cm.conversacion_id = cc.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY cc.id
        ORDER BY
          CASE cc.estado
            WHEN 'ABIERTO' THEN 1
            WHEN 'ATENDIENDO' THEN 2
            WHEN 'CERRADO' THEN 3
            ELSE 4
          END ASC,
          COALESCE(cc.last_message_at, cc.updated_at, cc.created_at) DESC
        LIMIT ?
      `,
      params
    );

    const [summaryRows] = await pool.query(
      `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN estado = 'ABIERTO' THEN 1 ELSE 0 END) AS abiertos,
          SUM(CASE WHEN estado = 'ATENDIENDO' THEN 1 ELSE 0 END) AS atendiendo,
          SUM(CASE WHEN estado = 'CERRADO' THEN 1 ELSE 0 END) AS cerrados,
          SUM(unread_admin) AS no_leidos_admin
        FROM chat_conversaciones
      `
    );

    res.json({
      ok: true,
      data: rows.map(mapConversation),
      summary: {
        total: Number(summaryRows[0]?.total || 0),
        abiertos: Number(summaryRows[0]?.abiertos || 0),
        atendiendo: Number(summaryRows[0]?.atendiendo || 0),
        cerrados: Number(summaryRows[0]?.cerrados || 0),
        no_leidos_admin: Number(summaryRows[0]?.no_leidos_admin || 0),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/admin/chat/conversaciones/from-cotizacion/:folio",
  adminChatAccess,
  async (req, res, next) => {
    try {
      const conversation = await createConversationFromCotizacion(req.params.folio, req);

      res.json({
        ok: true,
        data: mapConversation(conversation),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/admin/chat/conversaciones/:id", adminChatAccess, async (req, res, next) => {
  try {
    const id = Number(req.params.id || 0);
    const afterId = Number(req.query.after_id || 0);
    const limit = getSafeLimit(req.query.limit, 120, 250);

    const conversation = await getConversationById(id);

    if (!conversation) {
      return res.status(404).json({
        ok: false,
        message: "Conversación no encontrada.",
      });
    }

    await pool.query(
      `
        UPDATE chat_conversaciones
        SET
          unread_admin = 0,
          last_admin_read_at = NOW()
        WHERE id = ?
      `,
      [id]
    );

    const updated = await getConversationById(id);
    const messages = await getMessages(id, afterId, limit);

    res.json({
      ok: true,
      data: {
        conversation: mapConversation(updated),
        messages,
        after_id: afterId,
        last_message_id: Number(updated.last_message_id || 0),
        server_time: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/admin/chat/conversaciones/:id/mensajes",
  adminChatAccess,
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const id = Number(req.params.id || 0);
      const admin = getAdminIdentity(req);

      await connection.beginTransaction();

      const [[conversation]] = await connection.query(
        `
          SELECT *
          FROM chat_conversaciones
          WHERE id = ?
          FOR UPDATE
        `,
        [id]
      );

      if (!conversation) {
        await connection.rollback();

        return res.status(404).json({
          ok: false,
          message: "Conversación no encontrada.",
        });
      }

      const messageId = await insertMessage(connection, conversation, {
        emisor_tipo: "ADMIN",
        emisor_nombre: admin.nombre,
        emisor_correo: admin.correo,
        mensaje: req.body?.mensaje,
      });

      await connection.query(
        `
          UPDATE chat_conversaciones
          SET
            estado = CASE
              WHEN estado = 'ABIERTO' THEN 'ATENDIENDO'
              ELSE estado
            END,
            admin_asignado_nombre = COALESCE(admin_asignado_nombre, ?),
            admin_asignado_correo = COALESCE(admin_asignado_correo, ?),
            updated_at = NOW()
          WHERE id = ?
        `,
        [admin.nombre, admin.correo, id]
      );

      await connection.commit();

      res.json({
        ok: true,
        data: {
          message_id: messageId,
          server_time: new Date().toISOString(),
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

router.patch(
  "/admin/chat/conversaciones/:id/estado",
  adminChatAccess,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id || 0);
      const estado = normalizeEstado(req.body?.estado);

      if (!estado) {
        return res.status(400).json({
          ok: false,
          message: "Estado de chat inválido.",
        });
      }

      const admin = getAdminIdentity(req);

      const [result] = await pool.query(
        `
          UPDATE chat_conversaciones
          SET
            estado = ?,
            cerrado_at = CASE WHEN ? = 'CERRADO' THEN NOW() ELSE NULL END,
            admin_asignado_correo = COALESCE(admin_asignado_correo, ?),
            admin_asignado_nombre = COALESCE(admin_asignado_nombre, ?),
            updated_at = NOW()
          WHERE id = ?
        `,
        [estado, estado, admin.correo, admin.nombre, id]
      );

      if (!result.affectedRows) {
        return res.status(404).json({
          ok: false,
          message: "Conversación no encontrada.",
        });
      }

      const connectionLike = {
        query: (...args) => pool.query(...args),
      };

      await logChatEvent(
        connectionLike,
        id,
        "CAMBIO_ESTADO",
        `Estado actualizado a ${estado}.`,
        {
          estado,
          admin_correo: admin.correo,
        }
      );

      const updated = await getConversationById(id);

      res.json({
        ok: true,
        data: mapConversation(updated),
      });
    } catch (error) {
      next(error);
    }
  }
);

/* PUBLICO */

router.post("/chat/public/iniciar", async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    const nombre = cleanString(req.body?.nombre, 180);
    const whatsapp = validateWhatsappOrThrow(req.body?.whatsapp);
    const mensajeInicial = cleanString(req.body?.mensaje, 4000);

    const tipoIntencion = normalizeIntention(req.body?.tipo_intencion);
    const cotizacionFolio = cleanString(req.body?.cotizacion_folio || req.body?.folio, 80);
    const pedidoFolio = cleanString(req.body?.pedido_folio, 80);
    const productoCodigo = normalizeProductCode(req.body?.producto_codigo || req.body?.codigo_producto || req.body?.codigo);

    if (!nombre || !whatsapp || !mensajeInicial) {
      return res.status(400).json({
        ok: false,
        message: "Nombre, WhatsApp y mensaje son obligatorios.",
      });
    }

    const cotizacion = await findCotizacionByFolio(cotizacionFolio);

    const asuntoParts = [
      tipoIntencion,
      cotizacion?.folio || cotizacionFolio,
      pedidoFolio,
      productoCodigo,
    ].filter(Boolean);

    const asunto = asuntoParts.join(" · ") || "Consulta comercial";

    await connection.beginTransaction();

    const [[existing]] = await connection.query(
      `
        SELECT *
        FROM chat_conversaciones
        WHERE cliente_whatsapp = ?
          AND estado <> 'CERRADO'
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [whatsapp]
    );

    let conversationId = existing?.id;

    if (!conversationId) {
      const [result] = await connection.query(
        `
          INSERT INTO chat_conversaciones (
            public_token,
            cotizacion_id,
            cotizacion_folio,
            pedido_folio,
            producto_codigo,
            cliente_nombre,
            cliente_whatsapp,
            cliente_correo,
            asunto,
            estado,
            prioridad,
            canal,
            tipo_intencion,
            ultimo_mensaje,
            ultimo_emisor,
            last_message_at,
            unread_admin,
            unread_cliente
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'ABIERTO', 'MEDIA', 'PUBLICO', ?, ?, 'CLIENTE', NOW(), 1, 0)
        `,
        [
          createPublicToken(),
          cotizacion?.id || null,
          cotizacion?.folio || cotizacionFolio || null,
          pedidoFolio || null,
          productoCodigo || null,
          nombre,
          whatsapp,
          asunto,
          tipoIntencion,
          mensajeInicial,
        ]
      );

      conversationId = result.insertId;
    } else {
      await connection.query(
        `
          UPDATE chat_conversaciones
          SET
            cliente_nombre = ?,
            cotizacion_id = COALESCE(cotizacion_id, ?),
            cotizacion_folio = COALESCE(cotizacion_folio, ?),
            pedido_folio = COALESCE(pedido_folio, ?),
            producto_codigo = COALESCE(NULLIF(?, ''), producto_codigo),
            asunto = ?,
            tipo_intencion = ?,
            ultimo_mensaje = ?,
            ultimo_emisor = 'CLIENTE',
            last_message_at = NOW(),
            unread_admin = unread_admin + 1,
            updated_at = NOW()
          WHERE id = ?
        `,
        [
          nombre,
          cotizacion?.id || null,
          cotizacion?.folio || cotizacionFolio || null,
          pedidoFolio || null,
          productoCodigo || "",
          asunto,
          tipoIntencion,
          mensajeInicial,
          conversationId,
        ]
      );
    }

    await connection.query(
      `
        INSERT INTO chat_mensajes (
          conversacion_id,
          emisor_tipo,
          emisor_nombre,
          emisor_correo,
          mensaje,
          leido_admin,
          leido_cliente
        )
        VALUES (?, 'CLIENTE', ?, NULL, ?, 0, 1)
      `,
      [conversationId, nombre, mensajeInicial]
    );

    await logChatEvent(
      connection,
      conversationId,
      existing ? "REUTILIZACION_PUBLICA" : "CREACION_PUBLICA",
      existing
        ? "Cliente reutilizó una conversación abierta."
        : "Cliente inició una conversación pública.",
      {
        nombre,
        whatsapp,
        producto_codigo: productoCodigo || null,
        tipo_intencion: tipoIntencion,
      }
    );

    await connection.commit();

    const updated = await getConversationById(conversationId);

    res.json({
      ok: true,
      data: {
        public_token: updated.public_token,
        conversation: mapConversation(updated),
      },
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.get("/chat/public/:token", async (req, res, next) => {
  try {
    const token = cleanString(req.params.token, 96);
    const afterId = Number(req.query.after_id || 0);
    const limit = getSafeLimit(req.query.limit, 120, 250);

    const conversation = await getConversationByToken(token);

    if (!conversation) {
      return res.status(404).json({
        ok: false,
        message: "Chat no encontrado.",
      });
    }

    await pool.query(
      `
        UPDATE chat_conversaciones
        SET
          unread_cliente = 0,
          last_cliente_read_at = NOW()
        WHERE id = ?
      `,
      [conversation.id]
    );

    const updated = await getConversationById(conversation.id);
    const messages = await getMessages(conversation.id, afterId, limit);

    res.json({
      ok: true,
      data: {
        conversation: mapConversation(updated),
        messages,
        after_id: afterId,
        last_message_id: Number(updated.last_message_id || 0),
        server_time: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/chat/public/:token/mensajes", async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    const token = cleanString(req.params.token, 96);

    await connection.beginTransaction();

    const [[conversation]] = await connection.query(
      `
        SELECT *
        FROM chat_conversaciones
        WHERE public_token = ?
        FOR UPDATE
      `,
      [token]
    );

    if (!conversation) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: "Chat no encontrado.",
      });
    }

    if (conversation.estado === "CERRADO") {
      await connection.rollback();

      return res.status(409).json({
        ok: false,
        message:
          "Esta conversación está cerrada. Inicia un nuevo chat para continuar.",
      });
    }

    const messageId = await insertMessage(connection, conversation, {
      emisor_tipo: "CLIENTE",
      emisor_nombre: conversation.cliente_nombre || "Cliente",
      emisor_correo: conversation.cliente_correo || null,
      mensaje: req.body?.mensaje,
    });

    await connection.commit();

    res.json({
      ok: true,
      data: {
        message_id: messageId,
        server_time: new Date().toISOString(),
      },
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

export default router;