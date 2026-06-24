export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada",
    path: req.originalUrl,
  });
}

export function errorHandler(error, req, res, next) {
  const status = error.status || error.statusCode || 500;
  const message = error.message || "Error interno";

  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      status,
      method: req.method,
      url: req.originalUrl,
      adminId: req.admin?.id || null,
      message,
      stack: process.env.NODE_ENV !== "production" ? error.stack : undefined,
    })
  );

  res.status(status).json({
    ok: false,
    error:
      status >= 500 && process.env.NODE_ENV === "production"
        ? "Error interno del servidor"
        : message,
  });
}
