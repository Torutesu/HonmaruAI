import { expect, test } from "vitest";
import { resolveChannel } from "../src/channels.js";

function dbFor({ room = null, tombstone = null, failTombstone = false } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("FROM businesses")) return room;
              if (sql.includes("FROM hx_room_access")) {
                if (failTombstone) throw new Error("room tombstone storage unavailable");
                return tombstone;
              }
              if (sql.includes("FROM memberships WHERE")) return null;
              return null;
            },
            all: async () => {
              if (sql.includes("FROM conversation_members")) return { results: [] };
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

const viewer = { login: "reader", github_id: "reader-id" };

test("resolveChannel preserves virtual Rooms but rejects explicit deletion tombstones", async () => {
  const virtual = await resolveChannel(dbFor(), "org", viewer, "b:virtual-room");
  expect(virtual).toMatchObject({ key: "b:virtual-room", kind: "business", deliveryBoundary: { allowVirtual: true } });

  const deleted = await resolveChannel(dbFor({
    tombstone: { deleted: 1 },
  }), "org", viewer, "b:deleted-room");
  expect(deleted).toBeNull();
});

test("resolveChannel keeps archived private history closed to outsiders", async () => {
  const archived = await resolveChannel(dbFor({
    room: { private: 1, created_at: "2026-01-01T00:00:00.000Z", archived_at: "2026-11-01T00:00:00.000Z" },
  }), "org", viewer, "b:archived-private");
  expect(archived).toBeNull();
});

test("resolveChannel fails closed when deletion state cannot be read", async () => {
  await expect(resolveChannel(dbFor({ failTombstone: true }), "org", viewer, "b:virtual-room")).resolves.toBeNull();
});
