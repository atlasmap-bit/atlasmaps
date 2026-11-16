import type { Server, Socket } from "socket.io";
import { z } from "zod";
import {
  getLiveUser,
  getVisiblePresence,
  removeLiveUser,
  setLiveUser,
  updateLiveUser,
} from "./presence";

const joinSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(48),
  avatar: z.string().trim().min(1).max(20),
  contactPhone: z.string().trim().max(24).nullable().optional(),
  shareContact: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  altitude: z.number().nullable().optional(),
  speed: z.number().min(0).nullable().optional(),
});

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().nullable().optional(),
  speed: z.number().min(0).nullable().optional(),
});

const messageSchema = z.object({
  id: z.string().uuid(),
  toId: z.string().uuid(),
  text: z.string().trim().min(1).max(500),
  exactCoordinates: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
  contactPhone: z.string().trim().min(1).max(24).optional(),
});

const ghostSchema = z.object({ ghost: z.boolean() });
const contactSchema = z.object({
  contactPhone: z.string().trim().max(24).nullable(),
  shareContact: z.boolean(),
});

function publishPresence(io: Server): void {
  io.emit("masar:presence", getVisiblePresence());
}

function replyWithError(socket: Socket, message: string): void {
  socket.emit("masar:error", { message });
}

export function attachRealtimeHandlers(io: Server): void {
  io.on("connection", (socket) => {
    socket.on("masar:join", (input: unknown) => {
      const parsed = joinSchema.safeParse(input);
      if (!parsed.success) {
        replyWithError(socket, "تعذر الانضمام: تحقق من الاسم والملف الشخصي.");
        return;
      }

      const profile = parsed.data;
      const previous = getLiveUser(profile.id);
      if (previous && previous.socketId !== socket.id) {
        io.to(previous.socketId).emit("masar:session-replaced");
      }

      socket.data.userId = profile.id as string;
      socket.join(`user:${profile.id}`);
      setLiveUser({
        id: profile.id,
        name: profile.name,
        avatar: profile.avatar,
        latitude: profile.latitude ?? previous?.latitude ?? null,
        longitude: profile.longitude ?? previous?.longitude ?? null,
        altitude: profile.altitude ?? previous?.altitude ?? null,
        speed: profile.speed ?? previous?.speed ?? null,
        contactPhone: profile.contactPhone ?? null,
        shareContact: profile.shareContact ?? false,
        updatedAt: new Date(),
        ghost: previous?.ghost ?? false,
        socketId: socket.id,
      });
      publishPresence(io);
    });

    socket.on("masar:location", (input: unknown) => {
      const userId = socket.data.userId as string | undefined;
      const parsed = locationSchema.safeParse(input);
      if (!userId || !parsed.success) return;

      updateLiveUser(userId, socket.id, {
        ...parsed.data,
        altitude: parsed.data.altitude ?? null,
        speed: parsed.data.speed ?? null,
        updatedAt: new Date(),
      });
      publishPresence(io);
    });

    socket.on("masar:ghost", (input: unknown) => {
      const userId = socket.data.userId as string | undefined;
      const parsed = ghostSchema.safeParse(input);
      if (!userId || !parsed.success) return;
      updateLiveUser(userId, socket.id, { ghost: parsed.data.ghost });
      publishPresence(io);
    });

    socket.on("masar:contact", (input: unknown) => {
      const userId = socket.data.userId as string | undefined;
      const parsed = contactSchema.safeParse(input);
      if (!userId || !parsed.success) return;
      updateLiveUser(userId, socket.id, parsed.data);
      publishPresence(io);
    });

    socket.on(
      "masar:message",
      (
        input: unknown,
        acknowledge?: (result: { ok: boolean; error?: string }) => void,
      ) => {
      const fromId = socket.data.userId as string | undefined;
      const parsed = messageSchema.safeParse(input);
      if (!fromId || !parsed.success) {
        acknowledge?.({ ok: false, error: "تعذر إرسال الرسالة." });
        return;
      }

      const recipient = getLiveUser(parsed.data.toId);
      if (!recipient || recipient.ghost) {
        acknowledge?.({ ok: false, error: "المستخدم غير متصل حالياً." });
        return;
      }

      const message = {
        id: parsed.data.id,
        fromId,
        toId: parsed.data.toId,
        text: parsed.data.text,
        createdAt: new Date().toISOString(),
        exactCoordinates: parsed.data.exactCoordinates,
        contactPhone: parsed.data.contactPhone,
      };

      socket.emit("masar:message", message);
      if (recipient.socketId !== socket.id) {
        io.to(recipient.socketId).emit("masar:message", message);
      }
      acknowledge?.({ ok: true });
      },
    );

    socket.on("disconnect", () => {
      const userId = socket.data.userId as string | undefined;
      if (userId && removeLiveUser(userId, socket.id)) {
        publishPresence(io);
      }
    });
  });
}
