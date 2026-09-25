import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { router } from "./routes/index.js";

export const app = express();

app.set("trust proxy", env.trustProxy);

app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use(router);

app.use(notFound);
app.use(errorHandler);
