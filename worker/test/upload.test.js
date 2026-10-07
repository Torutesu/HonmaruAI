import { expect, test } from "vitest";
import { looksLike, peek } from "../src/upload.js";

const enc = (text) => new TextEncoder().encode(text);

test("each kind is known by how it starts", () => {
  expect(looksLike("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  expect(looksLike("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  expect(looksLike("image/gif", enc("GIF89a..."))).toBe(true);
  expect(looksLike("image/webp", enc("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
  expect(looksLike("image/heic", new Uint8Array([0, 0, 0, 0x18, ...enc("ftypheic")]))).toBe(true);
  expect(looksLike("image/avif", new Uint8Array([0, 0, 0, 0x18, ...enc("ftypavif")]))).toBe(true);
  expect(looksLike("video/quicktime", new Uint8Array([0, 0, 0, 8, ...enc("wide")]))).toBe(true);
  expect(looksLike("audio/mpeg", new Uint8Array([0xff, 0xfb, 0x90]))).toBe(true);
  expect(looksLike("audio/ogg", enc("OggS\0"))).toBe(true);
  expect(looksLike("text/plain", enc("hello"))).toBe(true);
});

test("a type is not vouched for by bytes of another kind, or by nothing", () => {
  expect(looksLike("image/png", enc("<svg onload=alert(1)>"))).toBe(false);
  expect(looksLike("image/heic", new Uint8Array([0, 0, 0, 0x18, ...enc("ftypisom")]))).toBe(false);
  expect(looksLike("video/mp4", new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
  expect(looksLike("text/plain", new Uint8Array([0x4d, 0x5a, 0, 0]))).toBe(false);
  expect(looksLike("image/png", new Uint8Array(0))).toBe(false);
  expect(looksLike("application/x-unknown", enc("anything"))).toBe(false);
});

test("peeking keeps every byte for the stream that follows", async () => {
  const chunks = [enc("abc"), enc("defgh"), enc("ij")];
  const body = new ReadableStream({ pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); } });
  const { head, stream } = await peek(body, 4);
  expect(new TextDecoder().decode(head)).toBe("abcd");
  expect(await new Response(stream).text()).toBe("abcdefghij");
});
