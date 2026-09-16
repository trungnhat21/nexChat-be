import { Router } from "express";

import { auth } from "../middlewares/auth.middleware.js";

import * as notificationController from "../controllers/notification.controller.js";

const router = Router();

router.get("/",auth,notificationController.getNotifications);

router.get("/unread-count",auth,notificationController.getUnreadCount);

router.patch("/read-all",auth,notificationController.markAllAsRead);

router.patch("/:id/read",auth,notificationController.markAsRead);

router.delete("/:id",auth,notificationController.deleteNotification);

export default router;