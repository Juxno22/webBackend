import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import healthRoutes from "./routes/health.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import catalogoRoutes from './routes/catalog.routes.js'
import quoteRoutes from './routes/quotes.routes.js'
import adminRoutes from "./routes/admin.routes.js";
import aiRoutes from './routes/ai.routes.js';

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

app.use(
    helmet({
        crossOriginResourcePolicy: false,
    })
);

app.use(
    cors({
        origin: CORS_ORIGIN,
        credentials: true,
    })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
    res.json({
        ok: true,
        message: "Andyfers Backend API funcionando",
        endpoints: {
            health: "/api/health",
            dbHealth: "/api/db-health",
            dbInfo: "/api/db-info",
        },
    });
});

app.use("/api", healthRoutes);
app.use("/api", catalogoRoutes);
app.use("/api", quoteRoutes);
app.use("/api", adminRoutes);
app.use("/api", aiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`Andyfers Backend API corriendo en http://localhost:${PORT}`);
});