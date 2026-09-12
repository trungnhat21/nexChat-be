import { Router } from "express";
import * as userController from "../controllers/user.controller";

const router = Router();

router.get("/", userController.getUsers);
router.get("/:id", userController.getUser);
router.post("/", userController.createUser);
router.patch("/:id", userController.updateUser);
router.delete("/:id", userController.deleteUser);

export default router;
