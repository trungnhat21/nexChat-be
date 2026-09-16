import { Router } from "express";
import * as friendController from "../controllers/friend.controller.js";
import {auth} from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/search",auth,friendController.searchUsers);

router.post("/request",auth,friendController.sendFriendRequest);

router.get("/requests/received",auth,friendController.getReceivedRequests);

router.get("/requests/sent",auth,friendController.getSentRequests);

router.patch("/requests/:id/accept",auth,friendController.acceptFriendRequest);

router.patch("/requests/:id/reject",auth,friendController.rejectFriendRequest);

router.get("/",auth,friendController.getFriends);

router.delete("/:friendId",auth,friendController.removeFriend);

router.post("/:userId/block",auth,friendController.blockUser
);

export default router;