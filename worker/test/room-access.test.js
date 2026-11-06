import { expect, test } from "vitest";
import { accessFor, audienceOf, mayRead, mayReadCard } from "../src/access.js";

function aclDb({ rooms = [], memberships = [], tombstones = [], role = null, failRoomAccess = false } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            all: async () => {
              if (sql.includes("FROM conversation_members") && sql.includes("SELECT channel")) {
                return { results: memberships.filter(row => row.login === args[1]) };
              }
              if (sql.includes("FROM conversation_members") && sql.includes("SELECT login")) {
                return { results: memberships.filter(row => row.channel === args[1]) };
              }
              if (sql.includes("FROM hx_room_access")) {
                if (failRoomAccess) throw new Error("room tombstone storage unavailable");
                return { results: tombstones.filter(row => row.channel === args[0] || row.org_id === args[0]) };
              }
              if (sql.includes("FROM businesses")) {
                return { results: rooms.filter(row => args.length < 2 || row.slug === args[1]) };
              }
              return { results: [] };
            },
            first: async () => {
              if (sql.includes("FROM memberships m JOIN users")) return role ? { role } : null;
              if (sql.includes("FROM hx_room_access")) {
                if (failRoomAccess) throw new Error("room tombstone storage unavailable");
                return tombstones.find(row => row.org_id === args[0] && row.channel === args[1]) || null;
              }
              if (sql.includes("FROM businesses")) return rooms.find(row => args.length < 2 || row.slug === args[1]) || null;
              if (sql.includes("FROM memberships WHERE")) return null;
              return null;
            },
          };
        },
      };
    },
  };
}

test("virtual rooms stay public while deleted private-room tombstones remain closed", async () => {
  const db = aclDb({
    rooms: [
      { slug: "public", private: 0 },
      { slug: "private", private: 1 },
      { slug: "archived-private", private: 1, archived_at: "2026-11-01T00:00:00.000Z" },
    ],
    tombstones: [{ org_id: "org", channel: "b:deleted-private", deleted_at: "2026-11-01T00:00:00.000Z" }],
  });
  const access = await accessFor(db, "org", "reader");

  expect(mayRead("b:public", access)).toBe(true);
  expect(mayRead("b:private", access)).toBe(false);
  expect(mayRead("b:archived-private", access)).toBe(false);
  expect(mayRead("b:general", access)).toBe(true);
  expect(mayRead("b:implicit-room", access)).toBe(true);
  expect(mayRead("b:deleted-private", access)).toBe(false);
  expect(mayRead("b:arbitrary-virtual-room", access)).toBe(true);
  expect(mayReadCard({ business: "deleted-private", visibility: "team" }, access)).toBe(false);
  expect(mayReadCard({ business: "arbitrary-virtual-room", visibility: "team" }, access)).toBe(true);
  expect(await audienceOf(db, "org", "b:deleted-private")).toEqual([]);
  expect(await audienceOf(db, "org", "b:arbitrary-virtual-room")).toBeNull();
  expect(await audienceOf(db, "org", "b:general")).toBeNull();
});

test("room tombstone storage failures fail closed", async () => {
  const db = aclDb({ failRoomAccess: true });
  await expect(accessFor(db, "org", "reader")).rejects.toThrow(/tombstone storage unavailable/);
  await expect(audienceOf(db, "org", "b:virtual-room")).rejects.toThrow(/tombstone storage unavailable/);
});

test("known private rooms remain member-only and known public rooms preserve workspace visibility", async () => {
  const db = aclDb({
    rooms: [{ slug: "public", private: 0 }, { slug: "private", private: 1 }],
    memberships: [{ channel: "b:private", login: "reader", added_at: "2026-01-01" }],
  });
  const member = await accessFor(db, "org", "reader");
  const outsider = await accessFor(db, "org", "other");

  expect(mayRead("b:private", member)).toBe(true);
  expect(mayRead("b:private", outsider)).toBe(false);
  expect(mayRead("b:public", outsider)).toBe(true);
  expect(await audienceOf(db, "org", "b:public")).toBeNull();
  expect(await audienceOf(db, "org", "b:private")).toEqual(["reader"]);
});
