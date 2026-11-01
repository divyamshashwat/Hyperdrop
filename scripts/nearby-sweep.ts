/**
 * Nearby calibration sweep (simulated): which tone set and symbol length pair most
 * reliably with people talking nearby?
 *
 *   npm run sweep:nearby                 # full grid, all cores
 *   npm run sweep:nearby -- --trials 20  # quicker
 *   npm run sweep:nearby -- --json out.json
 *
 * Grid: tone set × symbol length × speech-to-chirp ratio × talker kind × room. Each
 * cell plays one packet at a random offset into speech-noise (a random slice of a
 * synthetic bank), through room echo, with mic self-noise, and decodes it with the
 * real ToneDecoder. A cell reports the per-packet decode rate and, from it, the chance
 * of pairing within one 15 s broadcast. Separately, long speech-only runs count false
 * packets and spurious preamble locks ("Device found" flashes with nothing there).
 *
 * Cells are spread over worker processes (one per core) because the grid is large.
 */
import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ToneDecoder } from "../src/lib/proximity/decoder";
import { GAP_MS, type FrequencyProfile } from "../src/lib/proximity/modulation";
import { PACKET_SYMBOLS } from "../src/lib/proximity/protocol";
import { RATE, trial, type RoomKind } from "./nearby-sim/channel";
import { babble, bandShare, gaussian, rng, talker } from "./nearby-sim/speech";

const BROADCAST_S = 15;

/* ------------------------------------------------------------------ grid */

const TONE_SETS: Array<{ id: string; tones: [number, number, number, number] }> = [
  { id: "1.9-3.7", tones: [1900, 2500, 3100, 3700] },
  { id: "2.4-4.2*", tones: [2400, 3000, 3600, 4200] }, // shipping
  { id: "3.0-5.1", tones: [3000, 3700, 4400, 5100] },
  { id: "2.5-6.1w", tones: [2500, 3700, 4900, 6100] }, // wide spacing
  { id: "4.0-6.4", tones: [4000, 4800, 5600, 6400] },
  { id: "5.5-7.9", tones: [5500, 6300, 7100, 7900] },
];
const SYMBOL_MS = [30, 40, 50, 70];
/** Speech RMS relative to the chirp's RMS at the mic, dB. 0 = equally loud; +12 = speech much louder. */
const SPEECH_DB = [-6, 0, 6, 12, 18];
const TALKERS = ["close talker", "babble"] as const;
const ROOMS = ["30 cm", "1 m", "2 m"] as const;

type Talker = (typeof TALKERS)[number];

interface Cell {
  set: string;
  symbolMs: number;
  speechDb: number;
  talker: Talker;
  room: RoomKind;
  trials: number;
  seed: number;
}
interface CellResult extends Cell {
  decoded: number;
}
interface FalseCheck {
  set: string;
  symbolMs: number;
  talker: Talker;
  seconds: number;
  seed: number;
}
interface FalseResult extends FalseCheck {
  packets: number;
  locks: number;
}

const profileFor = (set: string, symbolMs: number): FrequencyProfile => {
  const t = TONE_SETS.find((s) => s.id === set)!;
  return { id: `${set}@${symbolMs}`, tones: t.tones, minSampleRate: 16000, symbolMs };
};

/* ---------------------------------------------------------------- worker */

async function worker() {
  const banks: Record<Talker, Float32Array> = {
    "close talker": talker(90, RATE, 11),
    babble: babble(90, RATE, 23),
  };
  process.send!({ type: "ready" });
  process.on("message", (m: { type: "cell"; cell: Cell } | { type: "false"; check: FalseCheck } | { type: "done" }) => {
    if (m.type === "done") process.exit(0);
    if (m.type === "cell") {
      const c = m.cell;
      const r = rng(c.seed);
      const profile = profileFor(c.set, c.symbolMs);
      let decoded = 0;
      for (let t = 0; t < c.trials; t++) if (trial(profile, c, banks[c.talker], r).ok) decoded++;
      process.send!({ type: "cell", result: { ...c, decoded } satisfies CellResult });
    } else {
      const c = m.check;
      const profile = profileFor(c.set, c.symbolMs);
      const bank = banks[c.talker];
      const r = rng(c.seed);
      const dec = new ToneDecoder(profile, RATE);
      let packets = 0;
      let locks = 0;
      // speech alone, loud (-26 dBFS), for `seconds`, cycling through the bank
      for (let done = 0; done < c.seconds * RATE; ) {
        const n = Math.min(2048, c.seconds * RATE - done);
        const chunk = new Float32Array(n);
        for (let i = 0; i < n; i++) chunk[i] = bank[(done + i) % bank.length] * 0.05 + 0.0005 * gaussian(r);
        for (const e of dec.push(chunk)) {
          if (e.type === "packet") packets++;
          if (e.type === "preamble") locks++;
        }
        done += n;
      }
      process.send!({ type: "false", result: { ...c, packets, locks } satisfies FalseResult });
    }
  });
}

/* ---------------------------------------------------------------- parent */

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`;
const packetSeconds = (symbolMs: number) => (PACKET_SYMBOLS * symbolMs + GAP_MS) / 1000;
/** Chance of at least one good packet in a 15 s broadcast, listener starting at a random moment. */
const pairIn15s = (p: number, symbolMs: number) => {
  const period = packetSeconds(symbolMs);
  const whole = Math.max(0, Math.floor((BROADCAST_S - period / 2) / period));
  return 1 - Math.pow(1 - p, whole);
};

async function parent() {
  const args = process.argv.slice(2);
  const trials = Number(args[args.indexOf("--trials") + 1]) || 40;
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const workers = Math.max(1, availableParallelism());

  const cells: Cell[] = [];
  let seed = 1;
  for (const s of TONE_SETS)
    for (const symbolMs of SYMBOL_MS)
      for (const speechDb of SPEECH_DB)
        for (const t of TALKERS) for (const room of ROOMS) cells.push({ set: s.id, symbolMs, speechDb, talker: t, room, trials, seed: seed++ });
  const checks: FalseCheck[] = [];
  for (const s of TONE_SETS) for (const symbolMs of SYMBOL_MS) for (const t of TALKERS) checks.push({ set: s.id, symbolMs, talker: t, seconds: 120, seed: seed++ });

  const sanityTalk = talker(20, RATE, 11);
  const sanityBabble = babble(20, RATE, 23);
  console.log(
    `speech energy in 2-4.5 kHz: close talker ${pct(bandShare(sanityTalk, RATE, 2000, 4500), 1)}, babble ${pct(bandShare(sanityBabble, RATE, 2000, 4500), 1)}` +
      ` · above 4.5 kHz: ${pct(bandShare(sanityTalk, RATE, 4500, 8000), 1)} / ${pct(bandShare(sanityBabble, RATE, 4500, 8000), 1)}`,
  );
  console.log(`${cells.length} cells × ${trials} trials + ${checks.length} false-positive runs on ${workers} workers…`);

  const t0 = Date.now();
  const results: CellResult[] = [];
  const falses: FalseResult[] = [];
  const jobs: Array<{ type: "cell"; cell: Cell } | { type: "false"; check: FalseCheck }> = [
    ...checks.map((check) => ({ type: "false" as const, check })),
    ...cells.map((cell) => ({ type: "cell" as const, cell })),
  ];
  const totalJobs = jobs.length;
  const self = fileURLToPath(import.meta.url);
  await Promise.all(
    Array.from({ length: workers }, () =>
      new Promise<void>((resolve, reject) => {
        const child = fork(self, ["--worker"], { execArgv: ["--import", "tsx"] });
        const next = () => {
          const job = jobs.shift();
          if (job) child.send(job);
          else child.send({ type: "done" });
        };
        child.on("message", (m: { type: string; result?: CellResult | FalseResult }) => {
          if (m.type === "cell") results.push(m.result as CellResult);
          if (m.type === "false") falses.push(m.result as FalseResult);
          if (m.type !== "ready") {
            const done = results.length + falses.length;
            if (done % 40 === 0) process.stderr.write(`  ${done}/${totalJobs} (${Math.round((Date.now() - t0) / 1000)} s)\n`);
          }
          next();
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      }),
    ),
  );
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s\n`);

  // Decode rate for one tone set × symbol length × speech level × distance, worst case over talker kinds.
  const rate = (set: string, ms: number, db: number, room: RoomKind, t: Talker) => {
    const rs = results.filter((r) => r.set === set && r.symbolMs === ms && r.speechDb === db && r.room === room && r.talker === t);
    return rs.reduce((a, r) => a + r.decoded, 0) / Math.max(1, rs.reduce((a, r) => a + r.trials, 0));
  };
  const worst = (set: string, ms: number, db: number, room: RoomKind) => Math.min(...TALKERS.map((t) => rate(set, ms, db, room, t)));
  const fmtDb = (d: number) => `${d >= 0 ? "+" : ""}${d} dB`;

  for (const room of ROOMS) {
    console.log(`\n### ${room} — per-packet decode rate, worst of close talker / babble (columns: speech level vs chirp)\n`);
    console.log(`| tones | symbol | packet | ${SPEECH_DB.map(fmtDb).join(" | ")} | pair ≤15 s @ +12 dB |`);
    console.log(`|---|---|---|${SPEECH_DB.map(() => "---").join("|")}|---|`);
    for (const s of TONE_SETS)
      for (const ms of SYMBOL_MS)
        console.log(
          `| ${s.id} | ${ms} ms | ${packetSeconds(ms).toFixed(2)} s | ${SPEECH_DB.map((db) => pct(worst(s.id, ms, db, room), 1)).join(" | ")} | ${pct(pairIn15s(worst(s.id, ms, 12, room), ms), 1)} |`,
        );
  }

  console.log("\n### False positives — 120 s of loud speech only, per talker kind\n");
  console.log("| tones | symbol | false packets | spurious preamble locks / min |");
  console.log("|---|---|---|---|");
  const fpOf = (set: string, ms: number) => {
    const f = falses.filter((x) => x.set === set && x.symbolMs === ms);
    return {
      packets: f.reduce((a, x) => a + x.packets, 0),
      locks: f.reduce((a, x) => a + x.locks, 0) / (f.reduce((a, x) => a + x.seconds, 0) / 60),
    };
  };
  for (const s of TONE_SETS)
    for (const ms of SYMBOL_MS) {
      const f = fpOf(s.id, ms);
      console.log(`| ${s.id} | ${ms} ms | ${f.packets} | ${f.locks.toFixed(1)} |`);
    }

  // Score at 1 m (the realistic distance): mean worst-case chance of pairing within 15 s over speech levels.
  const score = (set: string, ms: number, room: RoomKind) =>
    SPEECH_DB.reduce((a, db) => a + pairIn15s(worst(set, ms, db, room), ms), 0) / SPEECH_DB.length;
  const ranking = TONE_SETS.flatMap((s) =>
    SYMBOL_MS.map((ms) => ({ key: `${s.id} @ ${ms} ms`, set: s.id, ms, fp: fpOf(s.id, ms).packets, at1m: score(s.id, ms, "1 m") })),
  ).sort((a, b) => (a.fp ? 1 : 0) - (b.fp ? 1 : 0) || b.at1m - a.at1m);
  console.log("\n### Ranking — mean worst-case chance of pairing within 15 s across speech levels\n");
  console.log("| rank | tones @ symbol | 30 cm | 1 m | 2 m | false packets |");
  console.log("|---|---|---|---|---|---|");
  ranking.slice(0, 10).forEach((r, i) =>
    console.log(
      `| ${i + 1} | ${r.key} | ${pct(score(r.set, r.ms, "30 cm"), 1)} | ${pct(r.at1m, 1)} | ${pct(score(r.set, r.ms, "2 m"), 1)} | ${r.fp} |`,
    ),
  );
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ trials, results, falses }, null, 1));
}

if (process.argv.includes("--worker")) void worker();
else void parent();
