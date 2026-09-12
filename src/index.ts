import express from "express";
import dotenv from "dotenv";
import userRouters from "./routes/user.routes";
import authRouters from "./routes/auth.routes";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/users", userRouters);
app.use("/api/auth", authRouters);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
