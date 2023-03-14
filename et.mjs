#!/usr/bin/env node

import child_process from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const execFile = util.promisify(child_process.execFile);

async function mkdtemp() {
  return fs.mkdtemp(path.resolve(os.tmpdir(), "shoggoth-"));
}

const node_root = path.resolve("node");
const build_root = path.resolve(node_root, "out", "Release");

function mk_absolute_from_build_root(p) {
  return path.resolve(build_root, p);
}

async function config_gypi_parse(node_root) {
  return JSON.parse(
    (
      await fs.readFile(path.resolve(node_root, "config.gypi"), {
        encoding: "utf-8",
      })
    )
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .map((l) => l.replaceAll("'", '"'))
      .join("")
  );
}

const config_gypi = await config_gypi_parse(node_root);

function compdb_compile_cmd_parse(cmd) {
  const extra_include_dirs = [];
  const cxx_options = [];
  for (const arg of cmd.split(" ")) {
    if (arg.startsWith("-I")) {
      extra_include_dirs.push(
        mk_absolute_from_build_root(arg.replace("-I", ""))
      );
      continue;
    }
    if (
      arg.startsWith("-D") ||
      arg.startsWith("-f") ||
      arg.startsWith("-std")
    ) {
      cxx_options.push(arg);
      continue;
    }
  }
  return { extra_include_dirs, cxx_options };
}

function compdb_link_cmd_parse(cmd) {
  const whole_ars = new Set();
  const ars = new Set();
  const objs = new Set();
  let wl_whole_archive = false;
  for (const arg of cmd.split(" ")) {
    if (arg === "-Wl,--whole-archive") {
      wl_whole_archive = true;
      continue;
    }
    if (arg === "-Wl,--no-whole-archive") {
      wl_whole_archive = false;
      continue;
    }
    if (arg.startsWith("-Wl,--whole-archive,")) {
      wl_whole_archive = true;
      whole_ars.add(arg.replace("-Wl,--whole-archive,", ""));
      continue;
    }
    if (arg.startsWith("-Wl,-force_load,")) {
      whole_ars.add(arg.replace("-Wl,-force_load,", ""));
      continue;
    }
    if (arg.endsWith(".a")) {
      (wl_whole_archive ? whole_ars : ars).add(arg);
      continue;
    }
    if (arg.endsWith(".o")) {
      objs.add(arg);
      continue;
    }
  }
  return {
    whole_ars: Array.from(whole_ars).map(mk_absolute_from_build_root),
    ars: Array.from(ars)
      .filter((ar) => !whole_ars.has(ar))
      .map(mk_absolute_from_build_root),
    objs: Array.from(objs).map(mk_absolute_from_build_root),
  };
}

function compdb_find_by_output(compdb, basename) {
  return compdb.find((e) => path.basename(e.output) === basename);
}

async function whole_ar_to_obj(tmpdir, ar) {
  const o = path.resolve(tmpdir, `${path.basename(ar, ".a")}.o`);
  switch (process.platform) {
    case "linux": {
      await execFile("ld", ["-r", "--whole-archive", ar, "-o", o]);
      return;
    }
    case "darwin": {
      await execFile("ld", [
        "-r",
        "-arch",
        { x64: "x86_64", arm64: "arm64" }[config_gypi.variables.target_arch],
        "-force_load",
        ar,
        "-o",
        o,
      ]);
      return;
    }
    default:
      throw new Error(`whole_ar_to_obj: unsupported os ${process.platform}`);
  }
}

async function all_to_one(tmpdir, libname, whole_ars, ars, objs) {
  const whole_ar_objs = [];
  for (const ar of whole_ars) {
    await whole_ar_to_obj(tmpdir, ar);
    whole_ar_objs.push(path.resolve(tmpdir, `${path.basename(ar, ".a")}.o`));
  }
  await execFile("llvm-ar", [
    "qcL",
    path.resolve(tmpdir, `lib${libname}.a`),
    ...objs,
    ...whole_ar_objs,
    ...ars,
  ]);
}

console.log(config_gypi);

const compdb = JSON.parse(
  (
    await execFile("ninja", ["-C", build_root, "-t", "compdb"], {
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout
);

const tmpdir = await mkdtemp();
try {
  const { whole_ars, ars, objs } = compdb_link_cmd_parse(
    compdb_find_by_output(compdb, "node").command
  );
  await all_to_one(tmpdir, "shoggoth", whole_ars, ars, objs);
} finally {
  await fs.rm(tmpdir, { recursive: true });
}
