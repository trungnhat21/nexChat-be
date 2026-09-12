import type { Response } from "express";
import {Router} from "express";
import * as authController from "../controllers/auth.controller"
import {auth} from "../middlewares/auth.middleware";
import type { AuthRequest } from "../middlewares/auth.middleware";
const router = Router();

router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/refresh", authController.refresh);
router.post("/2fa/setup", auth, authController.setup2FA);
router.post("/2fa/enable", auth, authController.enable2FA);
router.post("/2fa/verify", authController.verify2FA);
router.post("/logout", authController.logout);

export default router;