export function notFoundHandler(req, res) {
    res.status(404).json({
        ok: false,
        error: "Ruta no encontrada",
        path: req.originalUrl,
    });
}

export function errorHandler(error, req, res, next) {
    console.error("Error backend:", error);

    res.status(error.status || 500).json({
        ok: false,
        error: error.message || "Error interno del servidor",
        details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
}