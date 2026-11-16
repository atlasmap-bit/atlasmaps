import { Router, type IRouter } from "express";
import { GetPresenceResponse } from "@workspace/api-zod";
import { getVisiblePresence } from "../lib/presence";

const router: IRouter = Router();

router.get("/presence", (_req, res) => {
  res.json(GetPresenceResponse.parse(getVisiblePresence()));
});

export default router;
