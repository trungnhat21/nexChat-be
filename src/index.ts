import express from "express";
import dotenv from "dotenv";
import userRouters from "./routes/user.routes.js";
import authRouters from "./routes/auth.routes.js";
import cookieParser from "cookie-parser";
import friendRouters from "./routes/friend.routes.js";
import notificationRoutes from "./routes/notification.routes.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/users", userRouters);
app.use("/api/auth", authRouters);
app.use("/api/friends", friendRouters);
app.use("/api/notifications", notificationRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
