import { GetPresenceResponseItem } from "@workspace/api-zod";
import type { infer as Infer } from "zod";

export type PresenceUser = Infer<typeof GetPresenceResponseItem>;

export type LiveUser = Omit<PresenceUser, "latitude" | "longitude"> & {
  latitude: number | null;
  longitude: number | null;
  ghost: boolean;
  socketId: string;
};

const users = new Map<string, LiveUser>();

export function getVisiblePresence(): PresenceUser[] {
  return Array.from(users.values())
    .filter(
      (user): user is LiveUser & { latitude: number; longitude: number } =>
        !user.ghost &&
        typeof user.latitude === "number" &&
        typeof user.longitude === "number",
    )
    .map(({ ghost: _ghost, socketId: _socketId, ...user }) =>
      GetPresenceResponseItem.parse(user),
    );
}

export function getLiveUser(id: string): LiveUser | undefined {
  return users.get(id);
}

export function setLiveUser(user: LiveUser): void {
  users.set(user.id, user);
}

export function removeLiveUser(id: string, socketId: string): boolean {
  const user = users.get(id);
  if (!user || user.socketId !== socketId) return false;
  users.delete(id);
  return true;
}

export function updateLiveUser(
  id: string,
  socketId: string,
  update: Partial<Omit<LiveUser, "id" | "socketId">>,
): LiveUser | undefined {
  const user = users.get(id);
  if (!user || user.socketId !== socketId) return undefined;
  const next = { ...user, ...update };
  users.set(id, next);
  return next;
}
