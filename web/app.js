/* Preview Translation — browser UI. Plain JS, hash routing, no build step. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const app = $("#app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const STATUS_LABEL = { created: "대기", queued: "대기열", running: "진행 중", done: "완료", error: "오류", cancelled: "취소됨" };
  const CONF_LABEL = { high: "높음", medium: "보통", low: "낮음" };
  const LANG_LABEL = { 영: "영어", 독: "독일어", 오: "오스트리아 독일어", 베: "베트남어", 중: "중국어", 일: "일본어" };

  // ------------------------------------------------------------ helpers
  async function api(url, opts = {}) {
    const res = await fetch(url, opts);
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error(body && body.error ? body.error : `${res.status} ${res.statusText}`);
    return body;
  }
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 3000);
  }
  const fmtTC = (sec) => {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return "";
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  };
  const fmtTCd = (sec) => (typeof sec === "number" ? fmtTC(sec) + "." + (Math.round((sec % 1) * 10) % 10) : "");
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("ko-KR", { hour12: false }) : "");
  const fmtDur = (a, b) => {
    if (!a || !b) return "";
    const s = Math.round((new Date(b) - new Date(a)) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const badge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;

  async function loadHealth() {
    try {
      const h = await api("/api/health");
      $("#health").innerHTML = [
        h.geminiKey ? "Gemini ✓" : '<span class="bad">GEMINI_API_KEY 없음</span>',
        h.ffmpeg ? "ffmpeg ✓" : '<span class="bad">ffmpeg 없음</span>',
        h.java ? "hwp 변환 ✓" : "hwp 변환 불가",
      ].join(" · ");
    } catch { /* offline */ }
  }

  // ------------------------------------------------------------ router
  let cleanup = () => {};
  function route() {
    cleanup();
    cleanup = () => {};
    const m = location.hash.match(/^#\/jobs\/([^/]+)/);
    if (m) renderJob(decodeURIComponent(m[1]));
    else renderHome();
  }
  window.addEventListener("hashchange", route);

  // ------------------------------------------------------------ home
  async function renderHome() {
    app.innerHTML = `
      <div class="panel">
        <h2>새 번역 작업</h2>
        <form id="new-job">
          <div class="row">
            <div class="field">
              <label>대본 파일 (.hwpx / .hwp)</label>
              <input type="file" name="hwpx" accept=".hwpx,.hwp" required />
            </div>
            <div class="field">
              <label>STT 패스 수</label>
              <select name="sttPasses">
                ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 3 ? "selected" : ""}>${n}회${n === 3 ? " (권장)" : ""}</option>`).join("")}
              </select>
              <span class="hint">패스를 여러 번 돌려 합치면 소음 속 조용한 대사를 놓치지 않습니다.</span>
            </div>
            <div class="field">
              <label>실행 방식</label>
              <select name="mode">
                <option value="agent" selected>에이전트 오케스트레이터 (권장)</option>
                <option value="fixed">고정 파이프라인</option>
              </select>
              <span class="hint">오케스트레이터는 각 단계의 결과를 확인하고 문제(누락된 STT, 잘못 매핑된 청크, 잘린 구간)를 스스로 고친 뒤 진행합니다. 고정 파이프라인은 정해진 순서로만 실행합니다.</span>
            </div>
          </div>
          <div class="row" style="margin-top:12px">
            <div class="field">
              <label>영상/음성</label>
              <div class="radio-row">
                <label><input type="radio" name="mediaMode" value="path" checked /> 서버에 있는 파일 경로</label>
                <label><input type="radio" name="mediaMode" value="upload" /> 브라우저에서 업로드</label>
              </div>
              <input type="text" name="mediaPath" placeholder="/Users/…/0828푸우롱.mp4" />
              <input type="file" name="mediaFile" accept=".mp3,.mp4,.wav,.m4a,.webm" hidden />
              <span class="hint">수 GB짜리 원본 영상은 서버(이 컴퓨터)에 이미 있는 파일 경로를 입력하는 편이 빠릅니다. 파일은 복사하지 않고 그 자리에서 읽습니다.</span>
              <div class="progress" id="upload-progress" hidden><div style="width:0%"></div></div>
            </div>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" type="submit">번역 시작</button>
            <span class="hint" id="submit-hint"></span>
          </div>
        </form>
      </div>
      <div class="panel">
        <h2>작업 목록</h2>
        <div id="job-list"><div class="empty">불러오는 중…</div></div>
      </div>`;

    const form = $("#new-job");
    const pathInput = form.mediaPath, fileInput = form.mediaFile;
    form.addEventListener("change", (e) => {
      if (e.target.name === "mediaMode") {
        const upload = form.mediaMode.value === "upload";
        pathInput.hidden = upload;
        fileInput.hidden = !upload;
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      const hint = $("#submit-hint");
      btn.disabled = true;
      try {
        const upload = form.mediaMode.value === "upload";
        if (!upload && !pathInput.value.trim()) throw new Error("영상/음성 파일 경로를 입력하세요");
        if (upload && !fileInput.files[0]) throw new Error("업로드할 영상/음성 파일을 선택하세요");
        const fd = new FormData();
        fd.append("hwpx", form.hwpx.files[0]);
        fd.append("sttPasses", form.sttPasses.value);
        fd.append("mode", form.mode.value);
        if (!upload) fd.append("mediaPath", pathInput.value.trim());
        hint.textContent = "작업 생성 중…";
        const job = await api("/api/jobs", { method: "POST", body: fd });
        if (upload) {
          hint.textContent = "영상 업로드 중…";
          await uploadMedia(job.id, fileInput.files[0], (p) => {
            const bar = $("#upload-progress");
            bar.hidden = false;
            bar.firstElementChild.style.width = `${Math.round(p * 100)}%`;
            hint.textContent = `영상 업로드 중… ${Math.round(p * 100)}%`;
          });
        }
        await api(`/api/jobs/${job.id}/start`, { method: "POST" });
        location.hash = `#/jobs/${job.id}`;
      } catch (err) {
        toast(err.message, true);
        hint.textContent = "";
        btn.disabled = false;
      }
    });

    await refreshJobList();
    const timer = setInterval(refreshJobList, 5000);
    cleanup = () => clearInterval(timer);
  }

  function uploadMedia(jobId, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/jobs/${jobId}/media?filename=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(safeErr(xhr.responseText) || `upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error("업로드 연결 실패"));
      xhr.send(file);
    });
  }
  const safeErr = (t) => { try { return JSON.parse(t).error; } catch { return t; } };

  async function refreshJobList() {
    const el = $("#job-list");
    if (!el) return;
    try {
      const jobs = await api("/api/jobs");
      if (!jobs.length) { el.innerHTML = '<div class="empty">아직 작업이 없습니다.</div>'; return; }
      el.innerHTML = `<table><thead><tr><th>대본</th><th>상태</th><th>생성</th><th>마커</th><th>청구(분)</th><th>확신도 (높/보/낮)</th><th></th></tr></thead><tbody>
        ${jobs.map((j) => {
          const s = j.summary;
          const cur = j.steps.find((x) => x.status === "running");
          return `<tr class="clickable" data-id="${esc(j.id)}">
            <td><a href="#/jobs/${esc(j.id)}">${esc(j.name)}</a></td>
            <td>${badge(j.status)} ${cur ? `<span class="meta">${esc(cur.label)}</span>` : ""}</td>
            <td class="meta">${fmtDate(j.createdAt)}</td>
            <td>${s ? s.markers : ""}</td>
            <td>${s && s.billableMin != null ? s.billableMin.toFixed(2) : ""}</td>
            <td>${s ? `${s.confidence.high} / ${s.confidence.medium} / ${s.confidence.low}` : ""}</td>
            <td class="actions">${j.files.output ? `<a class="btn small" href="/api/jobs/${esc(j.id)}/download">다운로드</a>` : ""}
              <button class="btn small danger" data-del="${esc(j.id)}">삭제</button></td>
          </tr>`;
        }).join("")}</tbody></table>`;
      el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("이 작업과 모든 중간 파일을 삭제할까요?")) return;
        try { await api(`/api/jobs/${b.dataset.del}`, { method: "DELETE" }); refreshJobList(); } catch (err) { toast(err.message, true); }
      }));
      el.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", (e) => {
        if (e.target.closest("a,button")) return;
        location.hash = `#/jobs/${tr.dataset.id}`;
      }));
    } catch (err) {
      el.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    }
  }

  // ------------------------------------------------------------ job page
  async function renderJob(id) {
    let job;
    try { job = await api(`/api/jobs/${id}`); } catch (err) { app.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; return; }

    const state = { job, tab: "translations", tr: null, dirty: new Map(), sttCache: new Map(), expanded: new Set(), filter: "", onlyLow: false, logLines: [] };
    app.innerHTML = `
      <div id="job-head"></div>
      <div class="panel"><div id="steps" class="steps"></div><div id="alerts" style="margin-top:12px"></div></div>
      <div id="cards" class="cards"></div>
      <div class="panel">
        <div class="tabs">
          <button class="tab" data-tab="translations">번역 결과</button>
          <button class="tab" data-tab="log">로그</button>
          <button class="tab" data-tab="billing">청구</button>
        </div>
        <div id="tab-body"></div>
      </div>`;
    app.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; renderTab(); }));

    renderHead();
    renderSteps();
    renderCards();
    renderTab();

    // Live updates. Log history is fetched once after the stream opens; lines
    // that arrive live in the meantime are merged so nothing is shown twice.
    const es = new EventSource(`/api/jobs/${id}/events`);
    let logHistoryLoaded = false;
    const pending = [];
    api(`/api/jobs/${id}/log?tail=3000`).then((r) => {
      const seen = new Set(r.lines);
      state.logLines = r.lines.concat(pending.filter((l) => !seen.has(l)));
      logHistoryLoaded = true;
      if (state.tab === "log") renderLog($("#tab-body"));
    }).catch(() => { logHistoryLoaded = true; state.logLines = pending.slice(); });
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "log") {
        (logHistoryLoaded ? state.logLines : pending).push(ev.line);
        if (state.logLines.length > 3000) state.logLines.splice(0, state.logLines.length - 3000);
        if (state.tab === "log") appendLog(ev.line);
      } else if (ev.type === "job") {
        const was = state.job.status;
        state.job = ev.job;
        renderHead(); renderSteps(); renderCards();
        if (was !== ev.job.status && ev.job.status === "done") { state.tr = null; if (state.tab === "translations") renderTab(); }
        if (state.tab === "billing" && was !== ev.job.status) renderTab();
      }
    };
    cleanup = () => es.close();

    function renderHead() {
      const j = state.job;
      const canStart = ["created", "error", "cancelled"].includes(j.status) && j.files.media;
      const running = j.status === "running" || j.status === "queued";
      $("#job-head").innerHTML = `
        <div class="job-head">
          <a href="#/" class="meta">← 목록</a>
          <h1>${esc(j.name)}</h1>
          ${badge(j.status)}
          <span class="meta">${fmtDate(j.createdAt)} · ${j.options.mode === "fixed" ? "고정 파이프라인" : "에이전트 오케스트레이터"} · STT ${j.options.sttPasses}회 · ${j.files.media ? esc(j.files.media.split("/").pop()) : "영상 없음"}</span>
          <div class="actions">
            ${j.files.output ? `<a class="btn primary" href="/api/jobs/${esc(j.id)}/download">번역본 HWPX 다운로드</a>` : ""}
            ${canStart ? `<button class="btn" id="btn-start">${j.status === "created" ? "시작" : "재시도 (이어서)"}</button>` : ""}
            ${running ? `<button class="btn danger" id="btn-cancel">취소</button>` : ""}
            <button class="btn danger" id="btn-delete">삭제</button>
          </div>
        </div>`;
      $("#btn-start")?.addEventListener("click", async () => { try { await api(`/api/jobs/${j.id}/start`, { method: "POST" }); } catch (err) { toast(err.message, true); } });
      $("#btn-cancel")?.addEventListener("click", async () => { try { await api(`/api/jobs/${j.id}/cancel`, { method: "POST" }); } catch (err) { toast(err.message, true); } });
      $("#btn-delete")?.addEventListener("click", async () => {
        if (!confirm("이 작업과 모든 중간 파일을 삭제할까요?")) return;
        try { await api(`/api/jobs/${j.id}`, { method: "DELETE" }); location.hash = "#/"; } catch (err) { toast(err.message, true); }
      });
    }

    function renderSteps() {
      const j = state.job;
      $("#steps").innerHTML = j.steps.map((s) => `
        <div class="step ${esc(s.status)}">
          <div class="name"><span class="dot"></span>${esc(s.label)}${s.endedAt && s.startedAt ? ` <span class="meta">${fmtDur(s.startedAt, s.endedAt)}</span>` : ""}</div>
          ${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ""}
        </div>`).join("");
      const alerts = [];
      if (j.error) alerts.push(`<div class="alert error"><b>오류:</b> ${esc(j.error)}</div>`);
      for (const w of j.warnings || []) alerts.push(`<div class="alert warn">${esc(w)}</div>`);
      if (j.report) {
        const r = j.report;
        alerts.push(`<div class="alert ${r.status === "done" ? "info" : "error"}"><b>오케스트레이터 보고</b> <span class="meta">(${esc(r.model)}, 모델 호출 ${r.llmCalls}회)</span><div style="white-space:pre-wrap;margin-top:4px">${esc(r.text)}</div>${r.review && r.review.length ? `<ul style="margin:6px 0 0 18px;padding:0">${r.review.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`);
      }
      if (j.status === "created" && !j.files.media) alerts.push(`<div class="alert info">영상 파일이 아직 없습니다. 목록에서 새 작업을 만들어 주세요.</div>`);
      $("#alerts").innerHTML = alerts.join("");
    }

    function renderCards() {
      const s = state.job.summary;
      const el = $("#cards");
      if (!s) { el.innerHTML = ""; return; }
      const ref = s.referenceMin ? `STT 기준 A ${s.referenceMin.A} · B ${s.referenceMin.B} · C ${s.referenceMin.C}` : "";
      el.innerHTML = `
        <div class="card"><div class="k">마커</div><div class="v">${s.markers}</div><div class="s">${s.chunks}개 청크</div></div>
        <div class="card"><div class="k">청구 시간</div><div class="v">${s.billableMin != null ? s.billableMin.toFixed(2) + " 분" : "–"}</div><div class="s">${esc(ref)}</div></div>
        <div class="card"><div class="k">확신도 높음</div><div class="v">${s.confidence.high}</div></div>
        <div class="card"><div class="k">확신도 보통</div><div class="v">${s.confidence.medium}</div></div>
        <div class="card"><div class="k">확신도 낮음 (??)</div><div class="v">${s.confidence.low}</div><div class="s">문서에서 ?? 로 표시</div></div>
        <div class="card"><div class="k">TC 분할</div><div class="v">${s.multiSegment}</div><div class="s">20초 초과 대사 분할</div></div>`;
    }

    function renderTab() {
      app.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
      const body = $("#tab-body");
      if (state.tab === "log") return renderLog(body);
      if (state.tab === "billing") return renderBilling(body);
      return renderTranslations(body);
    }

    // ---- log
    function renderLog(body) {
      body.innerHTML = `<div class="log" id="log"></div>`;
      const el = $("#log");
      el.innerHTML = state.logLines.map(logLine).join("\n");
      el.scrollTop = el.scrollHeight;
    }
    const logLine = (l) => `<span class="${/!!!|✗|Error|failed/i.test(l) ? "err" : ""}">${esc(l)}</span>`;
    function appendLog(line) {
      const el = $("#log");
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      el.insertAdjacentHTML("beforeend", "\n" + logLine(line));
      if (atBottom) el.scrollTop = el.scrollHeight;
    }

    // ---- billing
    async function renderBilling(body) {
      try {
        const b = await api(`/api/jobs/${id}/billing`);
        const rows = (b.per_chunk || []).map((c) => `<tr><td>${esc(c.chunk_id)}</td><td>${esc(c.scene)}</td><td>${c.markers}</td><td>${fmtTC(c.billable_sec)}</td></tr>`).join("");
        const flags = [];
        if (b.markers_zero_span) flags.push(`${b.markers_zero_span}개 마커에 매칭된 음성이 없음 (0초 구간)`);
        if (b.markers_unsupported_span?.length) flags.push(`STT에 외국어 발화가 없는 구간: #${b.markers_unsupported_span.join(", #")}`);
        if (b.markers_at_chunk_edge?.length) flags.push(`청크 경계에 닿은 구간 (잘렸을 수 있음): #${b.markers_at_chunk_edge.join(", #")}`);
        body.innerHTML = `
          <p><b>청구 기준</b>: 각 번역이 만들어진 음성 구간(speech_start–speech_end)의 합집합. 대상 언어: ${esc(b.target_language)}</p>
          <div class="cards">
            <div class="card"><div class="k">청구 시간</div><div class="v">${b.billable_min != null ? b.billable_min.toFixed(2) + " 분" : "–"}</div><div class="s">${b.billable_sec != null ? fmtTC(b.billable_sec) : ""} · ${b.markers_measured}/${b.markers} 마커 측정</div></div>
            <div class="card"><div class="k">참고 A (스캔한 음성 내 외국어 전체)</div><div class="v">${fmtTC(b.reference?.mean_sec?.A ?? 0)}</div></div>
            <div class="card"><div class="k">참고 B (첫 마커 이전 제외)</div><div class="v">${fmtTC(b.reference?.mean_sec?.B ?? 0)}</div></div>
            <div class="card"><div class="k">참고 C (마커가 있는 블록만)</div><div class="v">${fmtTC(b.reference?.mean_sec?.C ?? 0)}</div></div>
          </div>
          ${flags.map((f) => `<div class="alert warn">${esc(f)}</div>`).join("")}
          <table><thead><tr><th>청크</th><th>장면</th><th>마커</th><th>청구</th></tr></thead><tbody>${rows}</tbody></table>`;
      } catch (err) {
        body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
    }

    // ---- translations (editable)
    async function renderTranslations(body) {
      if (!state.tr) {
        try { state.tr = await api(`/api/jobs/${id}/translations`); } catch (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
      }
      const { markers, translations } = state.tr;
      if (!translations.length) {
        body.innerHTML = `<div class="empty">${state.job.status === "running" || state.job.status === "queued" ? "번역이 아직 진행 중입니다. 완료되면 여기에 표시됩니다." : "번역 결과가 아직 없습니다."}</div>`;
        return;
      }
      const byIdx = new Map(translations.map((t) => [t.markerIndex, t]));
      body.innerHTML = `
        <div class="tr-toolbar">
          <input type="search" id="tr-filter" placeholder="검색: 캐릭터, 장면, 번역 텍스트" value="${esc(state.filter)}" />
          <label><input type="checkbox" id="tr-low" ${state.onlyLow ? "checked" : ""}/> 확신도 낮음/보통만</label>
          <span class="spacer"></span>
          <span class="meta">행을 클릭하면 해당 구간의 STT 원문을 볼 수 있습니다. 번역·확신도를 고친 뒤 저장하면 HWPX를 다시 만듭니다.</span>
        </div>
        <table class="tr-table"><thead><tr><th>#</th><th>대본 TC</th><th>캐릭터</th><th>장면</th><th>번역 (TC 세그먼트)</th><th>확신도</th><th>음성 구간</th></tr></thead><tbody id="tr-body"></tbody></table>
        <div class="savebar" id="savebar" hidden>
          <span id="dirty-count"></span>
          <span class="spacer"></span>
          <button class="btn" id="btn-revert">되돌리기</button>
          <button class="btn primary" id="btn-save">저장 및 HWPX 재생성</button>
        </div>`;
      $("#tr-filter").addEventListener("input", (e) => { state.filter = e.target.value; renderRows(); });
      $("#tr-low").addEventListener("change", (e) => { state.onlyLow = e.target.checked; renderRows(); });
      $("#btn-revert").addEventListener("click", () => { state.dirty.clear(); state.tr = null; renderTab(); });
      $("#btn-save").addEventListener("click", save);
      renderRows();

      function renderRows() {
        const q = state.filter.trim().toLowerCase();
        const tbody = $("#tr-body");
        tbody.innerHTML = markers.filter((m) => {
          const t = byIdx.get(m.index);
          if (state.onlyLow && t && t.confidence === "high") return false;
          if (!q) return true;
          const hay = [m.charName, m.scene, m.hint, ...(t?.segments || []).map((s) => s.text)].join(" ").toLowerCase();
          return hay.includes(q);
        }).map((m) => rowHtml(m, byIdx.get(m.index))).join("");
        tbody.querySelectorAll("tr.main").forEach((tr) => tr.addEventListener("click", (e) => {
          if (e.target.closest("textarea,select,button,input")) return;
          toggleDetail(Number(tr.dataset.idx));
        }));
        tbody.querySelectorAll("textarea[data-seg]").forEach((ta) => ta.addEventListener("input", () => {
          const idx = Number(ta.dataset.idx), si = Number(ta.dataset.seg);
          const t = byIdx.get(idx);
          t.segments[si].text = ta.value;
          markDirty(idx);
          ta.classList.add("dirty");
        }));
        tbody.querySelectorAll("select[data-conf]").forEach((sel) => sel.addEventListener("change", () => {
          const idx = Number(sel.dataset.conf);
          byIdx.get(idx).confidence = sel.value;
          markDirty(idx);
          sel.classList.add("dirty");
        }));
        tbody.querySelectorAll("button[data-merge]").forEach((b) => b.addEventListener("click", () => {
          const idx = Number(b.dataset.idx), si = Number(b.dataset.merge);
          const t = byIdx.get(idx);
          t.segments[si - 1].text = (t.segments[si - 1].text + " " + t.segments[si].text).trim();
          t.segments.splice(si, 1);
          markDirty(idx); renderRows();
        }));
        tbody.querySelectorAll("button[data-split]").forEach((b) => b.addEventListener("click", () => {
          const idx = Number(b.dataset.idx), si = Number(b.dataset.split);
          const t = byIdx.get(idx);
          const seg = t.segments[si];
          const ta = tbody.querySelector(`textarea[data-idx="${idx}"][data-seg="${si}"]`);
          const pos = ta && ta.selectionStart > 0 && ta.selectionStart < ta.value.length ? ta.selectionStart : Math.floor(seg.text.length / 2);
          const next = t.segments[si + 1];
          const tsEnd = next ? next.timestamp : (t.speech_end ?? seg.timestamp);
          const ts = Math.round(((seg.timestamp + tsEnd) / 2) * 10) / 10;
          t.segments.splice(si + 1, 0, { timestamp: ts, text: seg.text.slice(pos).trim() });
          seg.text = seg.text.slice(0, pos).trim();
          markDirty(idx); renderRows();
          toast("세그먼트를 나눴습니다. 새 세그먼트의 TC는 중간값이므로 필요하면 수정하세요.");
        }));
        tbody.querySelectorAll("input[data-ts]").forEach((inp) => inp.addEventListener("change", () => {
          const idx = Number(inp.dataset.idx), si = Number(inp.dataset.ts);
          const v = parseTC(inp.value);
          if (v == null) { toast("TC 형식: m:ss.d 또는 초", true); return; }
          byIdx.get(idx).segments[si].timestamp = v;
          markDirty(idx);
        }));
        for (const idx of state.expanded) showDetail(idx);
      }

      function rowHtml(m, t) {
        if (!t) return `<tr class="main" data-idx="${m.index}"><td class="idx">${m.index}</td><td class="tc">${fmtTC(m.timestamp)}</td><td class="who">${esc(m.charName)}</td><td>${esc(m.scene)}</td><td colspan="3" class="meta">번역 없음</td></tr>`;
        const dur = typeof t.speech_end === "number" && typeof t.speech_start === "number" ? t.speech_end - t.speech_start : null;
        const segs = t.segments.map((s, i) => `
          <div class="seg">
            ${i === 0 ? `<span class="seg-tc" title="측정된 시작 시각">${fmtTCd(s.timestamp)}</span>` : `<input class="seg-tc" style="width:64px;border:1px solid var(--border);border-radius:4px;padding:2px 4px" data-ts="${i}" data-idx="${m.index}" value="${fmtTCd(s.timestamp)}" title="이 세그먼트의 TC (문서에 기록됨)" />`}
            <textarea data-seg="${i}" data-idx="${m.index}" rows="${Math.max(1, Math.ceil(s.text.length / 45))}">${esc(s.text)}</textarea>
            <button class="btn small" data-split="${i}" data-idx="${m.index}" title="커서 위치에서 세그먼트 나누기">나누기</button>
            ${i > 0 ? `<button class="btn small" data-merge="${i}" data-idx="${m.index}" title="앞 세그먼트와 합치기">합치기</button>` : ""}
          </div>`).join("");
        return `<tr class="main" data-idx="${m.index}">
          <td class="idx">${m.index}</td>
          <td class="tc">${fmtTC(m.timestamp)}${m.endTimestamp ? `<br>~${fmtTC(m.endTimestamp)}` : ""}</td>
          <td class="who">${esc(m.charName)}<br><span class="meta">${esc(LANG_LABEL[m.language] || m.language)}</span></td>
          <td>${esc(m.scene)}${m.hint ? `<div class="note">힌트: ${esc(m.hint)}</div>` : ""}</td>
          <td class="text">${segs}${t.note ? `<div class="note">${esc(t.note)}</div>` : ""}</td>
          <td><select class="conf-select" data-conf="${m.index}">${["high", "medium", "low"].map((c) => `<option value="${c}" ${t.confidence === c ? "selected" : ""}>${CONF_LABEL[c]}</option>`).join("")}</select></td>
          <td class="span">${fmtTCd(t.speech_start)}<br>${fmtTCd(t.speech_end)}<br>${dur != null ? `${dur.toFixed(1)}s` : ""}</td>
        </tr>`;
      }

      function markDirty(idx) {
        state.dirty.set(idx, true);
        const bar = $("#savebar");
        bar.hidden = false;
        $("#dirty-count").textContent = `${state.dirty.size}개 마커 수정됨`;
      }

      function toggleDetail(idx) {
        if (state.expanded.has(idx)) { state.expanded.delete(idx); $("#tr-body").querySelector(`tr.detail[data-idx="${idx}"]`)?.remove(); }
        else { state.expanded.add(idx); showDetail(idx); }
      }
      async function showDetail(idx) {
        const tbody = $("#tr-body");
        const main = tbody.querySelector(`tr.main[data-idx="${idx}"]`);
        if (!main || tbody.querySelector(`tr.detail[data-idx="${idx}"]`)) return;
        const m = markers.find((x) => x.index === idx), t = byIdx.get(idx);
        const row = document.createElement("tr");
        row.className = "detail"; row.dataset.idx = idx;
        row.innerHTML = `<td colspan="7">불러오는 중…</td>`;
        main.after(row);
        try {
          let stt = state.sttCache.get(m.chunk);
          if (!stt) { stt = await api(`/api/jobs/${id}/stt/${m.chunk}`); state.sttCache.set(m.chunk, stt); }
          const s0 = (t?.speech_start ?? m.timestamp) - 8, s1 = (t?.speech_end ?? m.timestamp) + 8;
          const utts = stt.utterances.filter((u) => u.abs_end >= s0 && u.abs_start <= s1);
          row.innerHTML = `<td colspan="7">
            <div class="meta" style="margin-bottom:6px">청크 ${esc(m.chunk)} · STT 원문 (${fmtTC(Math.max(0, s0))} – ${fmtTC(s1)}) · 노란색 = 이 번역이 만들어진 구간</div>
            ${utts.length ? utts.map((u) => {
              const inSpan = t && u.abs_end > t.speech_start && u.abs_start < t.speech_end;
              return `<div class="utt ${inSpan ? "in" : ""}"><span class="t">${fmtTCd(u.abs_start)}–${fmtTCd(u.abs_end)}</span><span class="sp">${esc(u.speaker)} <span class="hb">${esc(u.language)}${u.heard_by ? ` ${u.heard_by}/${u.of_passes}` : ""}</span></span><span class="tx">${esc(u.text)}${u.translation ? `<br><span class="ko">→ ${esc(u.translation)}</span>` : ""}</span></div>`;
            }).join("") : '<div class="meta">이 구간에 STT 발화가 없습니다.</div>'}
          </td>`;
        } catch (err) {
          row.innerHTML = `<td colspan="7" class="meta">${esc(err.message)}</td>`;
        }
      }

      async function save() {
        const btn = $("#btn-save");
        btn.disabled = true; btn.textContent = "저장 중… (HWPX 재생성)";
        try {
          const job = await api(`/api/jobs/${id}/translations`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ translations }) });
          state.job = job; state.dirty.clear(); state.tr = null;
          renderHead(); renderCards(); renderTab();
          toast("저장했습니다. 번역본 HWPX가 다시 만들어졌습니다.");
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false; btn.textContent = "저장 및 HWPX 재생성";
        }
      }
    }
  }

  function parseTC(v) {
    v = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
    const p = v.split(":").map(Number);
    if (p.some(Number.isNaN) || p.length < 2 || p.length > 3) return null;
    const [h, m, s] = p.length === 3 ? p : [0, p[0], p[1]];
    return Math.round((h * 3600 + m * 60 + s) * 10) / 10;
  }

  loadHealth();
  route();
})();
