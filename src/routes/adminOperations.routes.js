import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();

const adminOrVentas = [requireAdminAuth, requireRole(["ADMIN", "VENTAS"])];

function numberValue(value) {
  return Number(value || 0);
}

async function safeQuery(label, sql, params = [], fallback = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (error) {
    console.warn(`[admin-operacion] ${label}: ${error.message}`);
    return fallback;
  }
}

function firstRow(rows, fallback = {}) {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : fallback;
}

router.get("/admin/operacion/resumen", adminOrVentas, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const ecommerceClave = String(
      process.env.ECOMMERCE_SUCURSAL_CLAVE || "ECOMMERCE"
    ).trim();

    const stockMinimo = Number(req.query.stock_minimo || 3);

    const ventasKpiRows = await safeQuery(
      "ventas_kpis",
      `
        SELECT
          COUNT(*) AS total_ventas,
          SUM(CASE WHEN estado IN ('CREADA', 'PENDIENTE_PAGO') THEN 1 ELSE 0 END) AS pendientes_pago,
          SUM(CASE WHEN estado = 'PAGO_RECHAZADO' THEN 1 ELSE 0 END) AS rechazadas,
          SUM(CASE WHEN estado = 'PAGADA' THEN 1 ELSE 0 END) AS pagadas,
          SUM(CASE WHEN estado = 'EN_PREPARACION' THEN 1 ELSE 0 END) AS en_preparacion,
          SUM(CASE WHEN estado = 'LISTA_ENTREGA' THEN 1 ELSE 0 END) AS listas_entrega,
          SUM(CASE WHEN estado = 'ENTREGADA' THEN 1 ELSE 0 END) AS entregadas,
          SUM(CASE WHEN estado IN ('PAGADA', 'EN_PREPARACION', 'LISTA_ENTREGA') THEN 1 ELSE 0 END) AS pedidos_activos,
          SUM(CASE WHEN estado = 'PAGADA' THEN total ELSE 0 END) AS importe_pagado,
          SUM(CASE WHEN estado IN ('PAGADA', 'EN_PREPARACION', 'LISTA_ENTREGA') THEN total ELSE 0 END) AS importe_activo
        FROM ventas
      `,
      [],
      [
        {
          total_ventas: 0,
          pendientes_pago: 0,
          rechazadas: 0,
          pagadas: 0,
          en_preparacion: 0,
          listas_entrega: 0,
          entregadas: 0,
          pedidos_activos: 0,
          importe_pagado: 0,
          importe_activo: 0,
        },
      ]
    );

    const pedidosAccion = await safeQuery(
      "pedidos_accion",
      `
        SELECT
          id,
          folio,
          estado,
          nombre_cliente,
          whatsapp,
          total,
          moneda,
          created_at,
          pagado_at,
          updated_at
        FROM ventas
        WHERE estado IN (
          'PENDIENTE_PAGO',
          'PAGO_RECHAZADO',
          'PAGADA',
          'EN_PREPARACION',
          'LISTA_ENTREGA'
        )
        ORDER BY
          FIELD(
            estado,
            'PAGADA',
            'EN_PREPARACION',
            'LISTA_ENTREGA',
            'PENDIENTE_PAGO',
            'PAGO_RECHAZADO'
          ),
          updated_at DESC
        LIMIT 12
      `
    );

    const ecommerceRows = await safeQuery(
      "ecommerce_resumen",
      `
        SELECT
          COUNT(i.id) AS productos_ecommerce,
          SUM(
            CASE
              WHEN i.disponible_web = 1
                AND COALESCE(i.stock, 0) > 0
                AND COALESCE(i.precio_publico, 0) > 0
              THEN 1
              ELSE 0
            END
          ) AS vendibles,
          SUM(CASE WHEN COALESCE(i.stock, 0) <= 0 THEN 1 ELSE 0 END) AS sin_existencia,
          SUM(CASE WHEN COALESCE(i.precio, 0) <= 0 THEN 1 ELSE 0 END) AS sin_precio_interno,
          SUM(CASE WHEN COALESCE(i.precio_publico, 0) <= 0 THEN 1 ELSE 0 END) AS sin_precio_web,
          SUM(COALESCE(i.stock, 0)) AS piezas_totales,
          MAX(i.updated_at) AS ultima_actualizacion
        FROM inventario i
        JOIN sucursales s ON s.id = i.sucursal_id
        WHERE s.clave = ?
      `,
      [ecommerceClave],
      [
        {
          productos_ecommerce: 0,
          vendibles: 0,
          sin_existencia: 0,
          sin_precio_interno: 0,
          sin_precio_web: 0,
          piezas_totales: 0,
          ultima_actualizacion: null,
        },
      ]
    );

    const stockBajo = await safeQuery(
      "stock_bajo",
      `
        SELECT
          p.id AS producto_id,
          p.codigo_andyfers,
          p.codigo_importacion,
          p.descripcion,
          p.familia,
          c.nombre AS categoria,
          COALESCE(i.stock, 0) AS stock,
          i.precio AS precio_interno,
          i.precio_publico AS precio_web,
          i.updated_at
        FROM inventario i
        JOIN sucursales s ON s.id = i.sucursal_id
        JOIN productos p ON p.id = i.producto_id
        JOIN categorias c ON c.id = p.categoria_id
        WHERE s.clave = ?
          AND p.activo = 1
          AND p.activo_web = 1
          AND i.disponible_web = 1
          AND COALESCE(i.stock, 0) <= ?
        ORDER BY COALESCE(i.stock, 0) ASC, p.codigo_andyfers ASC
        LIMIT 12
      `,
      [ecommerceClave, stockMinimo]
    );

    const cotizacionesRows = await safeQuery(
      "cotizaciones_resumen",
      `
        SELECT
          COUNT(*) AS abiertas,
          SUM(CASE WHEN estado = 'NUEVA' THEN 1 ELSE 0 END) AS nuevas,
          SUM(CASE WHEN estado = 'EN_REVISION' THEN 1 ELSE 0 END) AS en_revision,
          SUM(CASE WHEN estado = 'CONTACTADO' THEN 1 ELSE 0 END) AS contactadas,
          SUM(CASE WHEN estado = 'COTIZADO' THEN 1 ELSE 0 END) AS cotizadas,
          SUM(CASE WHEN estado = 'EN_PROCESO' THEN 1 ELSE 0 END) AS en_proceso,
          SUM(CASE WHEN estado = 'REQUIERE_DATOS' THEN 1 ELSE 0 END) AS requiere_datos
        FROM cotizaciones
        WHERE estado IN (
          'NUEVA',
          'EN_REVISION',
          'CONTACTADO',
          'COTIZADO',
          'EN_PROCESO',
          'REQUIERE_DATOS'
        )
      `,
      [],
      [
        {
          abiertas: 0,
          nuevas: 0,
          en_revision: 0,
          contactadas: 0,
          cotizadas: 0,
          en_proceso: 0,
          requiere_datos: 0,
        },
      ]
    );

    const cotizacionesRecientes = await safeQuery(
      "cotizaciones_recientes",
      `
        SELECT
          id,
          folio,
          nombre_cliente,
          whatsapp,
          estado,
          origen,
          marca_vehiculo,
          modelo_vehiculo,
          anio_vehiculo,
          motor_vehiculo,
          created_at,
          updated_at
        FROM cotizaciones
        WHERE estado IN (
          'NUEVA',
          'EN_REVISION',
          'CONTACTADO',
          'COTIZADO',
          'EN_PROCESO',
          'REQUIERE_DATOS'
        )
        ORDER BY
          FIELD(
            estado,
            'NUEVA',
            'REQUIERE_DATOS',
            'EN_REVISION',
            'CONTACTADO',
            'COTIZADO',
            'EN_PROCESO'
          ),
          updated_at DESC
        LIMIT 10
      `
    );

    const ventas = firstRow(ventasKpiRows);
    const ecommerce = firstRow(ecommerceRows);
    const cotizaciones = firstRow(cotizacionesRows);

    res.json({
      ok: true,
      data: {
        generated_at: new Date().toISOString(),
        stock_minimo: stockMinimo,
        ventas: {
          total_ventas: numberValue(ventas.total_ventas),
          pendientes_pago: numberValue(ventas.pendientes_pago),
          rechazadas: numberValue(ventas.rechazadas),
          pagadas: numberValue(ventas.pagadas),
          en_preparacion: numberValue(ventas.en_preparacion),
          listas_entrega: numberValue(ventas.listas_entrega),
          entregadas: numberValue(ventas.entregadas),
          pedidos_activos: numberValue(ventas.pedidos_activos),
          importe_pagado: numberValue(ventas.importe_pagado),
          importe_activo: numberValue(ventas.importe_activo),
          pedidos_accion: pedidosAccion,
        },
        ecommerce: {
          productos_ecommerce: numberValue(ecommerce.productos_ecommerce),
          vendibles: numberValue(ecommerce.vendibles),
          sin_existencia: numberValue(ecommerce.sin_existencia),
          sin_precio_interno: numberValue(ecommerce.sin_precio_interno),
          sin_precio_web: numberValue(ecommerce.sin_precio_web),
          piezas_totales: numberValue(ecommerce.piezas_totales),
          ultima_actualizacion: ecommerce.ultima_actualizacion,
          stock_bajo: stockBajo,
        },
        cotizaciones: {
          abiertas: numberValue(cotizaciones.abiertas),
          nuevas: numberValue(cotizaciones.nuevas),
          en_revision: numberValue(cotizaciones.en_revision),
          contactadas: numberValue(cotizaciones.contactadas),
          cotizadas: numberValue(cotizaciones.cotizadas),
          en_proceso: numberValue(cotizaciones.en_proceso),
          requiere_datos: numberValue(cotizaciones.requiere_datos),
          recientes: cotizacionesRecientes,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;