import {expect,test} from "vitest";
import {accessFor,audienceOf,isGuest,isGuestLogin,isPrivate} from "../src/access.js";

const failedDb = {
  prepare() { return { bind() { return {
    first: async () => { throw new Error("ACL read unavailable"); },
    all: async () => { throw new Error("ACL read unavailable"); },
  }; } }; },
};
test.each([
  ["channel privacy",()=>isPrivate(failedDb,"org","room")],
  ["guest by ID",()=>isGuest(failedDb,"org","123")],
  ["guest by login",()=>isGuestLogin(failedDb,"org","reader")],
  ["broadcast audience",()=>audienceOf(failedDb,"org","b:room")],
  ["complete read access",()=>accessFor(failedDb,"org","reader")],
])("%s cannot turn a failed permission lookup into access",async (_name,read)=>{
  await expect(read()).rejects.toThrow("ACL read unavailable");
});
