# Performance and Memory Checks

This page describes the release benchmark, its measured baselines and its budgets.

The maintainer approved the budgets on 2026-11-17 and added 10 percent to each proposed budget.

## Run the Benchmark

Stop other programs that use the CPU. Then run this command.

```sh
pnpm run bench:release
```

The command does not need a build. One run takes approximately 27 seconds.

The command does these steps.

1. It starts a Vite server on `127.0.0.1:5201`. The server gives the library source in `src/` to the browser.
2. It starts headless Chromium through the Playwright library.
3. It runs each workload of `bench/` in a new browser context.
4. It writes the raw result to `bench-results/bench-<time>.json`. Git ignores this folder.
5. It compares each metric with `bench/budgets.json`.

The raw result contains the CPU model, the core count and the memory. It also contains the browser version, the Node version, the commit and the workload parameters. It contains the 1-minute load average at the start and at the end of the run.

The two servers listen on `127.0.0.1` only, and the page uses `127.0.0.1` in each URL. With `localhost`, a different program on the same port can receive the IPv4 traffic.

## Failure Criteria

The command exits with code 1 in these conditions.

- A metric is above its `max` budget or below its `min` budget. The verdict is `over budget`.
- A budget has no measured metric. The verdict is `no result`.
- The file `bench/budgets.json` does not exist.
- A workload loses records. The library reports a loss through `onDrop`.
- The library reports a diagnostic in a workload that uses the memory transport.
- The number of records in the memory transport is different from the number of calls.
- A latency block is shorter than 100 clock steps.
- Port 8801 on `127.0.0.1` is in use.
- The outage workload does not drain in 30 seconds.
- The replay recorder sends no events.
- A page throws an error.

A budget has no measured metric in two conditions. The first condition is a workload that does not run. An example is the replay workload when `@rrweb/record` is not installed. The second condition is a metric with a new name.

A metric without a budget shows `no budget`. It does not cause a failure.

The command compares the CPU model of the machine with the CPU model in `bench/budgets.json`. On a different CPU model, the command prints a note. It applies the same budgets, and the exit code rule does not change.

## Workloads

Each log call is `info("order accepted", payload)`. The payload has four fields. The parameters are in the `WORKLOAD` constant of `tools/bench-release.mjs`.

| Workload   | Load                                                                                            | Transport                |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| Latency    | 20 000 warm-up calls. Then 100 000 calls with a time for each call. Then 2 000 blocks of 500.   | Memory transport         |
| Throughput | Calls at the maximum rate for 5 seconds, 500 calls in each task.                                | Memory transport         |
| Heap       | 5 000 warm-up calls. Then 30 checkpoints of 10 000 calls. A task has 50 calls and a 1 ms sleep. | Memory transport         |
| Outage     | 2 000 records into a server that returns 503 for 3 seconds. Then the server returns 200.        | HTTP to `127.0.0.1:8801` |
| Replay     | 2 000 rounds of 20 new DOM rows, with the recorder off and then on. Needs `@rrweb/record`.      | Memory transport         |

Each workload sends one record and calls `flush()` before the load starts. The library loads its sender on the first record. Records that arrive before the sender loads go into a small hold buffer. A workload without this step loses records with the reason `buffer_full`.

The latency, throughput and heap workloads count the records in the memory transport after each task. Then they empty the transport. Without this step, the transport keeps each record of the run. The garbage collector then causes the slow calls, not the library. The code review of the first version reported a heap of 1 620 MB and a slowest call of approximately 1 000 microseconds.

### Latency

The page is cross-origin isolated. Thus `performance.now()` has a step of 5 microseconds in Chromium. Chromium also adds jitter of approximately one step to each read.

One call takes less than one clock step. The benchmark thus measures the call in two ways.

- **Per block.** The benchmark measures 500 calls together and divides the time by 500. The block percentiles have budgets.
- **Per call.** The benchmark measures each call. A call of 2.2 microseconds reads as 0, 5 or 10 microseconds. Thus the p50, p99 and p99.9 of this pass are **clock-limited**. The command prints them with this label, and they have no budget.

The per-call pass has one use. Its largest value, `latency.slowestCallUs`, shows a call that stops for 15 microseconds or more.

A block value is the mean of 500 calls. Thus a block percentile does not show one slow call.

The block size comes from a measurement. A block must be 100 clock steps or longer, which is 500 microseconds. These values are **measured**. The date is 2026-11-17. A temporary copy of `tools/bench-release.mjs` ran only the latency workload, one time for each block size. Each run had 2 000 blocks. The load average was 1.49 to 1.97.

| Calls in a block | Clock steps in the p50 block | Block p50 (ns/call) | Block p99 (ns/call) | Block p99.9 (ns/call) |
| ---------------- | ---------------------------- | ------------------- | ------------------- | --------------------- |
| 100              | 44                           | 2 200               | 2 550               | 2 900                 |
| 250              | 110                          | 2 200               | 2 740               | 2 900                 |
| 500              | 224                          | 2 240               | 2 540               | 2 960                 |
| 1 000            | 482                          | 2 410               | 2 575               | 2 675                 |

A block of 250 calls is only 10 percent above the limit. A block of 500 calls is 2.2 times the limit. With 500 calls, one clock step is 10 nanoseconds for each call.

The p99.9 of 2 000 blocks is the third-largest block.

### Heap

The benchmark reads `JSHeapUsedSize` through the Chrome DevTools Protocol command `Performance.getMetrics`. It calls `HeapProfiler.collectGarbage` before each read. The first read is after the warm-up. Then the benchmark reads the heap after each checkpoint of 10 000 records.

The heap increase does not scale with the number of records. These values are **measured**. The date is 2026-11-17. A temporary copy of `tools/bench-release.mjs` ran only the heap workload, one time for each sleep time. Each run had 40 checkpoints. The load average was 1.78 to 1.98.

| Records | Heap increase with a 1 ms sleep (KB) | Heap increase with a 10 ms sleep (KB) |
| ------- | ------------------------------------ | ------------------------------------- |
| 10 000  | 23                                   | 23                                    |
| 20 000  | 45                                   | 45                                    |
| 50 000  | 95                                   | 96                                    |
| 100 000 | 113                                  | 113                                   |
| 130 000 | 119                                  | 123                                   |
| 200 000 | 119                                  | 122                                   |
| 300 000 | 119                                  | 120                                   |
| 400 000 | 120                                  | 121                                   |

The heap increases in steps until 130 000 records. After that, it stays in a band of 6 KB. The steps are at the same record counts for the two sleep times. Thus the record count causes the steps, not the time. The benchmark does not identify the object that increases.

The benchmark thus divides the increase into two parts.

- `heap.slopeBytesPer10k` is the leak rate. The benchmark fits a line through the last 15 reads with the least-squares method. These reads are from 160 000 to 300 000 records. The slope is in bytes for each 10 000 records.
- `heap.fixedBytes` is the fixed part. It is the value of the line at 0 records minus the read after the warm-up.

The first 15 checkpoints are not in the fit. The budget is on the slope. The fixed part has no budget.

### Outage

The page uses the default storage, which is IndexedDB in Chromium. The workload sets `retention.maxAgeMs` and `retention.maxAttempts` to `null`. It sets `retryBaseDelayMs` to 200 and `retryMaxDelayMs` to 1000.

The benchmark reports two times.

- `outage.recoveryToDrainMs` is the time from the recovery to the last accepted batch.
- `outage.drainMs` is the time from the first accepted batch to the last accepted batch.

The retry timer has full jitter. Thus the first time includes a random wait of 0 to 1000 ms.

The second time starts when the server accepts batch 1. It stops when the server accepts batch 21. It includes one timer. The library sends a maximum of 20 batches in one drain pass (`BATCHES_PER_DRAIN`). The workload stores 21 batches. Thus the drain needs two passes, and the library calls `setTimeout` with a delay of 0 between them.

### Replay

One round adds 20 rows and sets one attribute on each row. The round ends after one microtask, because the recorder processes mutations in a microtask. The workload sets `replay.maxBufferBytes` to 100 000 000. The rounds give about 11 200 000 characters of events in less than 1 second. The default limit of 10 000 000 is then too small for one part. With the default limit, the buffer drops its only part. The library reports `capture.rate_limited`. The replay of the error then has only a new full snapshot. With 100 000 000, the upload has each event of the run. The workload stops its wait at the first segment.

The p99.9 of 2 000 rounds is the third-largest round. Thus `replay.onP999Us` is one sample, and it changes more between runs than the p50.

## Measured Baselines

These values are **measured**. The date is 2026-11-17. The command is `pnpm run bench:release`, run 5 times in sequence.

Before each run, a script read the 1-minute load average with `os.loadavg()[0]`. The limit for a run was a load average of 3.

| Item    | Value                                                                        |
| ------- | ---------------------------------------------------------------------------- |
| CPU     | Apple M5 Max, 18 cores                                                       |
| Memory  | 64 GiB                                                                       |
| System  | macOS, Darwin 25.6.0, arm64                                                  |
| Browser | Chromium 145.0.7632.6, headless                                              |
| Node    | v22.22.3                                                                     |
| Library | 0.12.0 at commit d2805b3, source from the Vite dev server                    |
| Tree    | The working tree had changes that were not committed. `src/` had no changes. |

| Metric                          | Unit      | Run 1   | Run 2   | Run 3   | Run 4   | Run 5   |
| ------------------------------- | --------- | ------- | ------- | ------- | ------- | ------- |
| Load average at the start       | 1 minute  | 0.94    | 1.63    | 1.71    | 1.70    | 2.09    |
| `latency.blockP50Ns`            | ns/call   | 2 200   | 2 200   | 2 210   | 2 200   | 2 210   |
| `latency.blockP99Ns`            | ns/call   | 2 520   | 2 440   | 2 470   | 2 560   | 2 440   |
| `latency.blockP999Ns`           | ns/call   | 2 700   | 2 670   | 2 650   | 2 770   | 2 540   |
| Clock steps in the p50 block    | steps     | 220     | 220     | 221     | 220     | 221     |
| `latency.p50Us`, clock-limited  | us        | 0       | 0       | 0       | 0       | 0       |
| `latency.p99Us`, clock-limited  | us        | 10      | 10      | 10      | 10      | 10      |
| `latency.p999Us`, clock-limited | us        | 10      | 10      | 10      | 10      | 10      |
| `latency.slowestCallUs`         | us        | 50      | 55      | 40      | 45      | 20      |
| `throughput.acceptedPerSecond`  | records/s | 321 416 | 325 093 | 323 593 | 324 807 | 322 734 |
| `heap.slopeBytesPer10k`         | bytes/10k | -62     | -65     | -62     | -62     | -62     |
| `heap.fixedBytes`               | bytes     | 122 940 | 128 671 | 123 964 | 124 400 | 124 432 |
| `outage.recoveryToDrainMs`      | ms        | 634     | 113     | 545     | 624     | 94      |
| `outage.drainMs`                | ms        | 30      | 42      | 38      | 35      | 42      |
| `replay.offP50Us`               | us/round  | 10      | 10      | 10      | 10      | 10      |
| `replay.onP50Us`                | us/round  | 85      | 85      | 85      | 85      | 85      |
| `replay.onP99Us`                | us/round  | 190     | 200     | 180     | 170     | 200     |
| `replay.onP999Us`               | us/round  | 3 005   | 2 820   | 2 125   | 2 635   | 2 680   |
| `replay.overheadP50Us`          | us/round  | 75      | 75      | 75      | 75      | 75      |

The load average at the end of the 5 runs was 1.63, 1.71, 1.70, 2.09 and 1.94. The benchmark itself adds to the load average.

No run lost a record. Each run had these counts.

- The latency workload made 1 120 000 calls, and the transport accepted 1 120 000 records.
- The throughput workload made 1 607 500 to 1 625 500 calls, and the transport accepted all of them.
- The heap workload made 300 000 calls, and the transport accepted 300 000 records.
- The outage workload stored 21 batches and delivered 2 000 of 2 000 records.
- The replay recorder sent 600 events.

### Variation Between Runs

Each percent value is the range of the 5 runs divided by the smallest value.

- `latency.blockP50Ns` changes by 10 ns, which is 0.5 percent. This is one clock step for a block of 500 calls.
- `latency.blockP99Ns` changes by 4.9 percent. `latency.blockP999Ns` changes by 9.1 percent.
- `latency.slowestCallUs` changes from 20 to 55 microseconds. It is one sample, and the benchmark gives it no budget.
- The throughput changes by 1.1 percent.
- `heap.slopeBytesPer10k` changes by 3 bytes. In each run, the 15 reads of the fit are in a band of 952 to 988 bytes.
- `heap.fixedBytes` changes by 4.7 percent.
- `outage.drainMs` changes by 12 ms, from 30 ms to 42 ms.
- `outage.recoveryToDrainMs` changes from 94 ms to 634 ms. The cause is the jitter of the retry timer.
- The replay p50 values are the same in the 5 runs. The clock step of 5 microseconds hides smaller changes.
- `replay.onP99Us` changes by 17.6 percent. `replay.onP999Us` changes by 41.4 percent.

## Budgets

The budgets are in `bench/budgets.json`. The maintainer approved them on 2026-11-17.

The maintainer added 10 percent to each proposed budget.

- An approved `max` is the proposed `max` times 1.1, rounded up.
- An approved `min` is the proposed `min` times 0.9, rounded down.
- A value in microseconds is rounded up to the next clock step of 5 microseconds.
- On a different CPU model, the command applies the same budgets. The maintainer examines a failure on that model.

The proposed budgets come from a rule with four parts.

- A `max` budget is the worst of the 5 runs plus a margin.
- The margin is 25 percent of the worst value or the floor of the unit. The rule uses the larger of the two.
- A `min` budget is the worst of the 5 runs minus 25 percent.
- A value in microseconds is rounded up to the next clock step of 5 microseconds. Other values are rounded up to an integer.

The floor prevents a failure from noise on a small value. Without the floor, the margin of a 40 ms value is 10 ms.

| Unit of the metric | Floor of the margin | Source of the floor                                                  |
| ------------------ | ------------------- | -------------------------------------------------------------------- |
| ms                 | 25 ms               | Two times the range of `outage.drainMs` in the 5 runs (12 ms).       |
| us                 | 10 us               | Two clock steps.                                                     |
| bytes/10k          | 1 000 bytes         | The band of the 15 heap reads in the fit (952 to 988 bytes).         |
| ns/call, records/s | No floor            | 25 percent of the value is much larger than the range of the 5 runs. |

| Metric                         | Worst of 5 | Margin             | Proposed    | Approved    |
| ------------------------------ | ---------- | ------------------ | ----------- | ----------- |
| `latency.blockP50Ns`           | 2 210      | 25 percent         | max 2 763   | max 3 040   |
| `latency.blockP99Ns`           | 2 560      | 25 percent         | max 3 200   | max 3 520   |
| `latency.blockP999Ns`          | 2 770      | 25 percent         | max 3 463   | max 3 810   |
| `throughput.acceptedPerSecond` | 321 416    | 25 percent         | min 241 062 | min 216 955 |
| `heap.slopeBytesPer10k`        | -62        | Floor, 1 000 bytes | max 938     | max 1 032   |
| `outage.drainMs`               | 42         | Floor, 25 ms       | max 67      | max 74      |
| `outage.recoveryToDrainMs`     | 634        | Not from the rule  | max 1 067   | max 1 174   |
| `replay.onP50Us`               | 85         | 25 percent         | max 110     | max 125     |
| `replay.onP99Us`               | 200        | 25 percent         | max 250     | max 275     |
| `replay.onP999Us`              | 3 005      | 25 percent         | max 3 760   | max 4 140   |

`outage.recoveryToDrainMs` does not use the rule. Its proposed budget is `retryMaxDelayMs` (1000 ms) plus the proposed `outage.drainMs` budget (67 ms), which gives 1067 ms. The random wait of the retry timer can be as long as `retryMaxDelayMs`. The approved budget adds 10 percent, as for each other budget.

A slope budget of 938 bytes for each 10 000 records is approximately 0.1 byte for each record.

These metrics have no budget.

- `latency.p50Us`, `latency.p99Us` and `latency.p999Us` are clock-limited.
- `latency.slowestCallUs` is one sample.
- `heap.fixedBytes` is a reported value only.
- `replay.offP50Us` is two clock steps.
- `replay.overheadP50Us` is the difference of two other metrics.

The budgets come from the machine in the table above. On a different CPU model, the command prints a note and applies the same budgets. The maintainer examines a failure on that model. The maintainer can then measure 5 runs there and calculate new budgets with the rule.

## Limits of the Baselines

- The values are for one machine and one browser. They do not apply to other hardware.
- The browser runs the source from the Vite dev server. The published bundle is minified, and its speed can be different.
- The heap run has 300 000 records. It does not show a leak that starts after more records.
- The heap fit has 15 reads. It does not show a leak rate below the margin of the slope budget.
- The memory transport does no serialization for the network and no compression. The latency and throughput values do not include these costs.
- A block percentile is a mean of 500 calls. It does not show the time of one slow call.
- The percentile functions of `bench/shared.js` and of `playground/vanilla/profiler.ts` are separate copies. This is a known duplication.
