---
name: profile-websocket
description: Find out why this repo's WebSocket server (lib/) is slow or uses memory, and prove whether a change made it faster. Profiles CPU time and allocations under the same k6 load as `pnpm bench`, summarizes the profiles by area and function with file and line, and compares the working tree against a git ref with a better, worse or no-clear-difference verdict per metric. Use it before and after any `perf:` change, when asked where time or memory goes, or when comparing with the ws library.
---

# Profile the WebSocket library

`pnpm bench` says how fast the server is. This skill says **why**, and whether a change helped. It drives the same echo servers and k6 scenarios as `bench/` (see "Benchmarks" in the README), so the numbers are comparable.

Run everything from the repository root after `pnpm install`, with k6 installed (`k6 version`; see https://grafana.com/docs/k6/latest/set-up/install-k6/). The examples use this variable:

```bash
P=.claude/skills/profile-websocket/scripts
```

## The loop

1. **Baseline.** Know the numbers before you touch anything: `pnpm bench --cases echo-1kib` (or the case you care about), or the last README results.
2. **Profile.** Find where the time and the memory go: `$P/profile.ts --case echo-1kib --servers ours,ws`. Comparing with `ws` shows what a faster implementation does differently.
3. **Change** one thing in `lib/`.
4. **Compare.** Prove the effect: `$P/compare.ts --base master`. Only a `better` verdict counts as an improvement.
5. **Check behaviour.** A faster server that breaks the protocol is not an improvement. Run `pnpm test`, the relevant `verify-websocket` recipes, and Autobahn for changes to framing, UTF-8 or compression.

## Profile

```bash
$P/profile.ts --case echo-1kib                         # CPU and allocations of our server
$P/profile.ts --case echo-1kib --servers ours,ws       # both, to compare where they spend
$P/profile.ts --case echo-16b --kind cpu --servers ours@master,ours
```

The options are `--case` (one of `echo-16b`, `echo-1kib`, `echo-64kib`, `connect`, `latency` from `bench/run.ts`), `--servers` (`ours` is the working tree, `ours@<git ref>` is `lib/` at that ref, and `ws` is the reference library; servers on Bun, such as `ours:bun`, can't be profiled, because Bun's inspector returns empty CPU profiles and has no heap profiler), `--kind cpu|heap|both` (default `both`), `--seconds` (default 10), `--warmup` (default 3), `--top` (default 25) and `--id`.

Each server runs once per kind. The profile covers only the measured window, after the warm-up: `bench/run.ts --profile` starts the inspector in the server when the warm-up ends and stops it when the load does. Then `analyze-profile.ts` prints a summary like this:

```
Sampled 5.362 s: busy 4.438 s (83%), idle 0.924 s
Per item (793,013 items): 5.60 µs of CPU
By area (share of busy time):
   63.6%     2.825 s  native / V8 builtins
   17.4%     0.774 s  lib/ (this library)
Top 25 functions by self time:
   60.9%  writeBuffer  [native / V8 builtins]
   12.6%  addData  lib/web-socket-frame.ts:52  [lib/ (this library)]
Top 25 functions in lib/ by total time (self and everything they call):
   66.1%  writeFrame  lib/web-socket-connection.ts:597  (3.70 µs per item)
```

How to read it:

- **Areas.** `lib/` is this library. `Node internals` are `node:` modules such as streams and buffers. `native / V8 builtins` are functions without a script, such as socket writes (`writeBuffer`, `writev` are system calls), `TextDecoder` and `Buffer` copies. `garbage collector` is GC time. `bench/` is the echo server itself.
- **Self time** points at where the CPU actually is. **Total time** for `lib/` functions points at which of our code paths pays for it, native calls included. Start from a big total in `lib/`, then look at which self-time entries it calls.
- **Per item** divides by the messages (or connections) handled while profiling, so profiles of runs at different speeds can be compared. For a heap profile it is bytes allocated per message.
- **Heap profiles count every allocation**, including memory the GC has already freed. They show allocation pressure, which is what drives GC pauses and peak memory, not a leak.

Profiling slows the server by about 5-10%. Never quote throughput from a profile run. Use `compare.ts` or `pnpm bench`.

## Compare

```bash
$P/compare.ts --base master                                  # 3 echo cases, 5 runs each
$P/compare.ts --base master --cases echo-1kib,latency --runs 7
$P/compare.ts --from bench/results/compare/<id>/bench.json   # judge saved results again
```

This runs `bench/run.ts` with `ours@<base>` and `ours` (the working tree, uncommitted changes included) on the same machine, alternating them run by run, and prints one row per case and metric:

```
| Case | Metric | Base median | Head median | Change | Base runs | Head runs | Verdict |
| echo-16b | echoes/s | 213,137 | 150,409 | -29.4% | ... | ... | worse |
| echo-16b | peak memory | 142 MiB | 142 MiB | +0.5% | ... | ... | no clear difference (consistent, under 2%) |
```

The verdict is `better` or `worse` only when every run of one side beats every run of the other and the medians differ by at least `--min-change` percent (default 2). Anything else is `no clear difference`. Rates (`/s`) are better higher; times, peak memory and GC pause are better lower. Use at least 5 runs (the default): with 3, identical code gets a verdict by chance about one time in ten per metric. Before relying on the tool on a new machine, run it once against your own `HEAD` with no changes. Every verdict should be `no clear difference`.

A case that doesn't count gets `not counted (see warnings)` instead of a verdict, and a warning under the table says why: connection errors or dropped connections, or an echo case where the server used under 85% CPU, which means k6 was the limit and not the server.

## Evidence

Everything goes under `bench/results/` (git-ignored). Cleanup never deletes it:

| Path                           | Content                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bench/results/profiles/<id>/` | `*.cpuprofile` and `*.heapprofile` (open them in Chrome DevTools or speedscope if needed), a `.txt` summary next to each, and `bench-<kind>.json` with the load numbers of the profiled runs |
| `bench/results/compare/<id>/`  | `bench.json` with every run, the revisions compared and the settings, and `compare.md` with the verdict table                                                                                |

Proof standards for a performance claim:

- Quote the `compare.md` table for the cases you claim, with its header line, which names both revisions. The `Base runs` and `Head runs` columns show the spread.
- Claim an improvement only for metrics marked `better`. Report `worse` metrics too, even in cases you didn't target. A change that speeds up 16 B echoes and slows 64 KiB ones must say so.
- Explain the effect with a profile. Quote the before and after lines of `analyze-profile.ts` (per-item time or bytes of the functions you changed), not just the throughput.
- Name the machine, and don't compare numbers from different machines, from different versions of Node or k6, or from a run with other heavy work going on. `bench/run.ts` refuses to run unless the versions are the pinned ones (`bench/versions.json`); install them with the `mise install` command it prints rather than pinning other versions. Plugged-in power and no other benchmarks running matter.

## Cleanup

Nothing stays running. `bench/run.ts` starts a fresh server for every run and stops it by its PID, and a server whose runner dies stops itself when the IPC channel closes. If a run is interrupted, check with `pgrep -fl bench/servers` and stop any PID it lists, never by name. Old profiles can be deleted from `bench/results/` by hand.

## Helpers

| Script                                          | Use                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `profile.ts`                                    | Profile servers under a benchmark case and print summaries                       |
| `compare.ts`                                    | Working tree against a git ref, with a verdict per metric                        |
| `analyze-profile.ts <file> [--top n] [--per n]` | Summarize one `.cpuprofile` or `.heapprofile`, e.g. one opened from an older run |

They rely on these options of `bench/run.ts`, which work on their own too: servers named `ours@<git ref>`, `--profile cpu|heap` with `--profile-dir <dir>`, and `--out <file>`. Its results file records the revision each server ran and the GC count and pause time of every run.
