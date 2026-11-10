import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readTranscript, readTranscriptTail } from "../src/transcripts.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const SESSION = "22222222-2222-4222-8222-222222222222";

/** A profile with a stray file in `projects/` and the transcript in the second project folder. */
function profile() {
  const configDir = temporaryDirectory();
  const projects = join(configDir, "projects");
  mkdirSync(join(projects, "-a"), { recursive: true });
  mkdirSync(join(projects, "-b"), { recursive: true });
  writeFileSync(join(projects, "notes.txt"), "not a project");
  writeFileSync(join(projects, "-b", `${SESSION}.jsonl`), "first\nsecond\n");
  return configDir;
}

test("a transcript is found in whichever project folder has it", async () => {
  const text = await readTranscript(SESSION, profile());
  assert.equal(text, "first\nsecond\n");
});

test("a project folder that is a symlink is searched too", async () => {
  const configDir = temporaryDirectory();
  const elsewhere = join(configDir, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, `${SESSION}.jsonl`), "linked\n");
  mkdirSync(join(configDir, "projects"));
  symlinkSync(elsewhere, join(configDir, "projects", "-moved"), "dir");
  const text = await readTranscript(SESSION, configDir);
  assert.equal(text, "linked\n");
});

test("the tail is the last bytes of the transcript", async () => {
  const tail = await readTranscriptTail(SESSION, profile(), 7);
  assert.equal(tail, "second\n");
});

test("a missing transcript or profile is undefined, and stray files are skipped quietly", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const missing = await readTranscript("33333333-3333-4333-8333-333333333333", profile());
  const noProfile = await readTranscript(SESSION, join(temporaryDirectory(), "nothing"));
  assert.equal(missing, undefined);
  assert.equal(noProfile, undefined);
  assert.equal(logged.mock.callCount(), 0);
});

test("an id that is not a session id is never looked up", async () => {
  const configDir = profile();
  const traversal = await readTranscript(`../-b/${SESSION}`, configDir);
  assert.equal(traversal, undefined);
});
