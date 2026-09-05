import fs from "fs";
import path from "path";
import {
  ROOT,
  DATA_DIR,
  attachUploadedMedia,
  cancelJob,
  createJob,
  deleteJob,
  getJob,
  getLog,
  listJobs,
  loadAll,
  readBilling,
  readStt,
  readTranslations,
  saveTranslations,
  startJob,
  subscribe,
} from "./jobs";

// Web app for the HWPX translation pipeline.
//   bun run web          → http://localhost:3000
// Env: PORT, PT_DATA_DIR (default ./data), GEMINI_API_KEY (required for STT/MAP).

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEB_DIR = path.join(ROOT, "web");

loadAll();

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (err: unknown, status = 400) => json({ error: err instanceof Error ? err.message : String(err) }, status);

function health() {
  const java = "/opt/homebrew/opt/openjdk/bin/java";
  return {
    ok: true,
    geminiKey: Boolean(process.env.GEMINI_API_KEY),
    ffmpeg: Boolean(Bun.which("ffmpeg")),
    java: fs.existsSync(java),
    dataDir: DATA_DIR,
  };
}

function withJob(id: string, fn: (job: NonNullable<ReturnType<typeof getJob>>) => Response | Promise<Response>) {
  const job = getJob(id);
  if (!job) return json({ error: "No such job" }, 404);
  try {
    return fn(job);
  } catch (err) {
    return fail(err);
  }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  maxRequestBodySize: 64 * 1024 ** 3, // multi-GB episode video uploads
  routes: {
    "/": () => new Response(Bun.file(path.join(WEB_DIR, "index.html"))),
    "/app.js": () => new Response(Bun.file(path.join(WEB_DIR, "app.js"))),
    "/style.css": () => new Response(Bun.file(path.join(WEB_DIR, "style.css"))),

    "/api/health": () => json(health()),

    "/api/jobs": {
      GET: () => json(listJobs()),
      POST: async (req) => {
        try {
          const form = await req.formData();
          const hwpx = form.get("hwpx");
          if (!(hwpx instanceof File) || hwpx.size === 0) throw new Error("Upload a .hwpx or .hwp file as 'hwpx'");
          const mediaPath = String(form.get("mediaPath") ?? "").trim() || undefined;
          const sttPasses = parseInt(String(form.get("sttPasses") ?? "3"), 10);
          const mapConcurrency = parseInt(String(form.get("mapConcurrency") ?? "4"), 10);
          const job = await createJob({ hwpx, mediaPath, sttPasses: Number.isFinite(sttPasses) ? sttPasses : 3, mapConcurrency: Number.isFinite(mapConcurrency) ? mapConcurrency : 4 });
          return json(job, 201);
        } catch (err) {
          return fail(err);
        }
      },
    },

    "/api/jobs/:id": {
      GET: (req) => withJob(req.params.id, (job) => json(job)),
      DELETE: (req) =>
        withJob(req.params.id, (job) => {
          deleteJob(job.id);
          return json({ ok: true });
        }),
    },

    "/api/jobs/:id/media": {
      PUT: async (req) => {
        const job = getJob(req.params.id);
        if (!job) return json({ error: "No such job" }, 404);
        const name = new URL(req.url).searchParams.get("filename") ?? "media.mp4";
        if (!req.body) return fail("empty body");
        try {
          return json(await attachUploadedMedia(job.id, name, req.body));
        } catch (err) {
          return fail(err);
        }
      },
    },

    "/api/jobs/:id/start": { POST: (req) => withJob(req.params.id, (job) => json(startJob(job.id))) },
    "/api/jobs/:id/cancel": {
      POST: (req) =>
        withJob(req.params.id, (job) => {
          cancelJob(job.id);
          return json(getJob(job.id));
        }),
    },

    "/api/jobs/:id/log": {
      GET: (req) =>
        withJob(req.params.id, (job) => {
          const tail = parseInt(new URL(req.url).searchParams.get("tail") ?? "500", 10);
          return json({ lines: getLog(job.id, Number.isFinite(tail) ? tail : 500) });
        }),
    },

    "/api/jobs/:id/events": {
      GET: (req) =>
        withJob(req.params.id, (job) => {
          let unsub = () => {};
          let timer: ReturnType<typeof setInterval>;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const send = (ev: unknown) => {
                try {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
                } catch {
                  unsub();
                  clearInterval(timer);
                }
              };
              send({ type: "job", job: getJob(job.id) });
              unsub = subscribe(job.id, send);
              timer = setInterval(() => send({ type: "ping" }), 20000);
            },
            cancel() {
              unsub();
              clearInterval(timer);
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
          });
        }),
    },

    "/api/jobs/:id/translations": {
      GET: (req) => withJob(req.params.id, (job) => json(readTranslations(job.id))),
      PUT: async (req) => {
        const job = getJob(req.params.id);
        if (!job) return json({ error: "No such job" }, 404);
        try {
          const body = await req.json();
          return json(await saveTranslations(job.id, body.translations ?? body));
        } catch (err) {
          return fail(err);
        }
      },
    },

    "/api/jobs/:id/stt/:chunk": { GET: (req) => withJob(req.params.id, (job) => json(readStt(job.id, req.params.chunk))) },
    "/api/jobs/:id/billing": { GET: (req) => withJob(req.params.id, (job) => json(readBilling(job.id))) },

    "/api/jobs/:id/download": {
      GET: (req) =>
        withJob(req.params.id, (job) => {
          const out = job.files.output;
          if (!out || !fs.existsSync(out)) return json({ error: "No translated HWPX yet" }, 404);
          const name = path.basename(out);
          return new Response(Bun.file(out), {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            },
          });
        }),
    },
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

const h = health();
console.log(`preview-translation web app → http://localhost:${server.port}`);
console.log(`  data dir: ${DATA_DIR}`);
if (!h.geminiKey) console.warn("  WARNING: GEMINI_API_KEY is not set — STT and mapping will fail");
if (!h.ffmpeg) console.warn("  WARNING: ffmpeg not found on PATH — audio extraction will fail");
if (!h.java) console.warn("  note: Homebrew OpenJDK not found — .hwp input cannot be converted (brew install openjdk)");
