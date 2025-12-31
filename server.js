import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { connectDB } from "./src/config/db.js";
import apiRoutes from "./src/routes/apiRoutes.js";
import viewRoutes from "./src/routes/viewRoutes.js";
import { initCronJobs } from "./src/services/workerService.js";
import { loadSources } from "./src/services/sourceService.js";

// --- INITIALIZATION ---
dotenv.config();
const app = express();
const PORT = process.env.PORT || 4001;

// --- DB & CONFIG ---
connectDB();
await loadSources(); // Pre-load sources for schedulers

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// --- ROUTES ---
app.use("/api", apiRoutes);
app.use("/", viewRoutes);

// --- WORKERS ---
initCronJobs();

// --- START ---
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard available at http://localhost:${PORT}/dashboard`);
});