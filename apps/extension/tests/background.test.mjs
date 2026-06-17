// Unit tests for background.js's pure helpers (Node's built-in runner).
//
// background.js guards its chrome.* registrations behind `typeof chrome` and
// exports these helpers as ESM, so importing it here (Node) is side-effect-free.
// It imports HOST_NAME from @harpe/core, which Node resolves from the workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirOf, safeFilename, buildSubfolder, tweetToken } from "../src/background.js";

test("dirOf returns the folder of a path (both separators)", () => {
  assert.equal(dirOf("/home/u/Videos/harpe/x.com/clip.mp4"), "/home/u/Videos/harpe/x.com");
  assert.equal(dirOf("C:\\Users\\u\\img.jpg"), "C:\\Users\\u");
  assert.equal(dirOf("nofolder"), "nofolder");
});

test("safeFilename keeps real extensions, defaults to .jpg, strips junk", () => {
  assert.equal(safeFilename("https://x/r2mYBJRfVf53plLi.mp4?tag=12"), "r2mYBJRfVf53plLi.mp4");
  assert.equal(safeFilename("https://cdn.example.com/media/abc123"), "abc123.jpg");
  assert.match(safeFilename("https://x/a b/c%20d.png"), /\.png$/);
  assert.equal(safeFilename("not a url"), "image.jpg");
});

test("buildSubfolder is Downloads-relative, site-nested, traversal-safe", () => {
  assert.equal(buildSubfolder("harpe", "https://www.x.com/p"), "harpe/x.com");
  assert.equal(buildSubfolder("", "https://x.com/p"), "harpe/x.com");
  const t = buildSubfolder("../../etc", "https://x.com/p");
  assert.ok(!t.includes(".."), `traversal not stripped: ${t}`);
  assert.equal(buildSubfolder("art", ""), "art"); // no referer → no site segment
});

test("tweetToken matches Twitter's syndication algorithm", () => {
  // Reference: ((Number(id)/1e15)*Math.PI).toString(36).replace(/(0+|\.)/g,'')
  const id = "2034694139066077325";
  const expected = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  assert.equal(tweetToken(id), expected);
});
