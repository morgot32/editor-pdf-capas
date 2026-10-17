"use strict";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const ui = { status: $("status"), layers: $("layers"), tabs: $("tabs"), pdfInput: $("pdfInput"), projectInput: $("projectInput") };
const panes = ["A", "B"].map((suffix) => ({
  suffix, root: $("pane" + suffix), viewport: $("viewport" + suffix), stage: $("pageStage" + suffix),
  image: $("pageImage" + suffix), overlay: $("overlay" + suffix), empty: $("empty" + suffix),
  name: $("paneName" + suffix), pageInfo: $("pageInfo" + suffix), zoomLabel: $("zoomLabel" + suffix),
  docId: null, loadedKey: null, imageUrl: null, renderToken: 0, interaction: null,
  detailImage: null, detailUrl: null, detailTimer: null, detailToken: 0, detailRegion: null,
  touchPoints: new Map(), pinch: null, ignoreTouchUntilClear: false
}));
panes.forEach((pane) => {
  pane.detailImage = document.createElement("img");
  pane.detailImage.className = "detail-image";
  pane.detailImage.alt = "";
  pane.detailImage.draggable = false;
  pane.detailImage.hidden = true;
  pane.image.after(pane.detailImage);
});
const app = { docs: new Map(), order: [], activePane: 0, split: false, tool: "hand", temporaryHand: false,
  pdfSort: "name", listOpen: false };
const staticMode = Boolean(window.EDITOR_PDF_STATIC);
let backendCheck = null;
let browserBackendPromise = null;
function browserBackend() { return browserBackendPromise ||= import("./browser-backend.js"); }

async function ensureBackend() {
  if (staticMode) { await browserBackend(); return; }
  if (!backendCheck) backendCheck = (async () => {
    const response = await fetch("/api/capabilities", { cache: "no-store" });
    if (!response.ok || !(await response.json()).multiDocument)
      throw new Error("El servidor abierto es una versión anterior. Ejecuta ABRIR_EDITOR.cmd y usa la nueva dirección que aparece en la consola.");
  })();
  return backendCheck;
}

function status(message) { ui.status.textContent = message; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function validInkColor(value, fallback = "#d44332") {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}
function currentDoc() { return app.docs.get(panes[app.activePane].docId) || null; }
function docFor(index) { return app.docs.get(panes[index].docId) || null; }
function defaultLayer(index) {
  const colors = ["#ffe45c", "#7de0ba", "#9bcaff", "#f9a9bf", "#c8b4fa"];
  return { id: crypto.randomUUID(), name: `Capa ${index}`, color: colors[(index - 1) % colors.length], opacity: 0.35,
    visible: true, role: "highlight" };
}
function newInkLayer(doc, color = doc.inkColor) {
  const count = doc.layers.filter((layer) => layer.role === "ink").length;
  return { id: crypto.randomUUID(), name: count ? `Dibujo ${count + 1}` : "Dibujo", color: validInkColor(color),
    opacity: 1, visible: true, role: "ink" };
}
function newDoc(info, hash) {
  const layer = defaultLayer(1);
  return { id: info.id, name: info.name, hash: hash || info.sha256 || "", pages: info.pages, page: 0, zoom: 1,
    openedAt: info.openedAt || Date.now(), modifiedAt: info.modifiedAt || 0, inkWidth: 3, inkColor: "#d44332",
    layers: [layer], marks: [], activeLayerId: layer.id, selectedMarkId: null, undo: [], redo: [] };
}
function activeLayer(doc) { return doc.layers.find((layer) => layer.id === doc.activeLayerId); }
function projectState(doc) { return { layers: doc.layers, marks: doc.marks, activeLayerId: doc.activeLayerId }; }
function snapshot(doc) { return JSON.stringify(projectState(doc)); }
function persist(doc) {
  try { (staticMode ? localStorage : sessionStorage).setItem("editor-pdf-" + doc.id, JSON.stringify({ ...projectState(doc), hash: doc.hash,
    page: doc.page, zoom: doc.zoom, inkWidth: doc.inkWidth, inkColor: doc.inkColor })); }
  catch { /* El editor sigue funcionando si el almacenamiento del navegador se llena. */ }
}
function restore(doc, value) {
  const saved = JSON.parse(value);
  doc.layers = saved.layers; doc.marks = saved.marks; doc.activeLayerId = saved.activeLayerId;
  doc.selectedMarkId = null; persist(doc); renderAll();
}
function mutate(doc, action) {
  const before = snapshot(doc);
  action();
  if (snapshot(doc) !== before) {
    doc.undo.push(before); if (doc.undo.length > 100) doc.undo.shift(); doc.redo = [];
    persist(doc);
  }
  renderAll();
}
function eraseMark(doc, id) {
  if (!doc || !doc.marks.some((mark) => mark.id === id)) return;
  mutate(doc, () => {
    doc.marks = doc.marks.filter((mark) => mark.id !== id);
    doc.selectedMarkId = null;
  });
  status(`Marca borrada de ${doc.name} · Ctrl+Z para deshacer`);
}
function undo() {
  const doc = currentDoc(); if (!doc?.undo.length) return;
  doc.redo.push(snapshot(doc)); restore(doc, doc.undo.pop()); status("Cambio deshecho");
}
function redo() {
  const doc = currentDoc(); if (!doc?.redo.length) return;
  doc.undo.push(snapshot(doc)); restore(doc, doc.redo.pop()); status("Cambio rehecho");
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function responseError(response) {
  try { return (await response.json()).error || `Error HTTP ${response.status}`; }
  catch { return `Error HTTP ${response.status}`; }
}
async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function renderTabs() {
  ui.tabs.replaceChildren();
  for (const id of app.order) {
    const doc = app.docs.get(id); if (!doc) continue;
    const tab = document.createElement("button");
    tab.className = "doc-tab" + (currentDoc()?.id === id ? " active" : "");
    tab.title = doc.name + " · " + doc.marks.length + " marcas";
    const name = document.createElement("span"); name.className = "tab-name"; name.textContent = doc.name;
    const close = document.createElement("span"); close.className = "tab-close"; close.textContent = "×"; close.title = "Cerrar PDF";
    close.onclick = (event) => { event.stopPropagation(); closeDoc(id); };
    tab.append(name, close); tab.onclick = () => selectDoc(id); ui.tabs.append(tab);
  }
  renderPdfList();
}
function sortedDocs() {
  const docs = app.order.map((id) => app.docs.get(id)).filter(Boolean);
  if (app.pdfSort === "name") return docs.sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" }));
  if (app.pdfSort === "modified") return docs.sort((a, b) => (b.modifiedAt || b.openedAt) - (a.modifiedAt || a.openedAt));
  return docs.sort((a, b) => b.openedAt - a.openedAt);
}
function renderPdfList() {
  $("pdfListCount").textContent = String(app.order.length);
  $("pdfSort").value = app.pdfSort;
  const items = $("pdfListItems"); items.replaceChildren();
  const docs = sortedDocs();
  if (!docs.length) { const empty = document.createElement("div"); empty.className = "pdf-list-empty";
    empty.textContent = "Todavía no hay PDF abiertos."; items.append(empty); return; }
  for (const doc of docs) {
    const row = document.createElement("button"); row.className = "pdf-list-item" + (currentDoc()?.id === doc.id ? " active" : "");
    const name = document.createElement("strong"); name.textContent = doc.name;
    const detail = document.createElement("small");
    const date = app.pdfSort === "modified" ? (doc.modifiedAt || doc.openedAt) : doc.openedAt;
    const label = app.pdfSort === "modified" ? "Archivo" : "Abierto";
    detail.textContent = `${doc.pages.length} pág. · ${label}: ${new Date(date).toLocaleString("es-CL")} · ${doc.marks.length} marcas`;
    row.append(name, detail); row.onclick = () => { selectDoc(doc.id); togglePdfList(false); }; items.append(row);
  }
}
function togglePdfList(open) {
  app.listOpen = open; $("pdfListMenu").hidden = !open;
  $("pdfListButton").setAttribute("aria-expanded", String(open));
  if (open) renderPdfList();
}
function selectDoc(id) {
  if (!app.docs.has(id)) return;
  if (app.split && panes[1 - app.activePane].docId === id) app.activePane = 1 - app.activePane;
  else panes[app.activePane].docId = id;
  renderAll();
}
function activatePane(index) {
  if (index === 1 && !app.split) return;
  app.activePane = index;
  renderTabs(); renderLayers(); renderButtons();
  panes.forEach((pane, number) => pane.root.classList.toggle("active-pane", number === index));
}
function setSplit(enabled) {
  app.split = enabled;
  if (!enabled) app.activePane = 0;
  else if (!panes[1].docId || panes[1].docId === panes[0].docId)
    panes[1].docId = app.order.find((id) => id !== panes[0].docId) || null;
  renderAll();
  if (enabled) requestAnimationFrame(() => { fitPane(0); fitPane(1); });
}
async function closeDoc(id) {
  const doc = app.docs.get(id); if (!doc) return;
  if (doc.marks.length && !confirm(`¿Cerrar “${doc.name}”? Guarda el proyecto o exporta el PDF si necesitas conservar las marcas.`)) return;
  const previousPane = app.activePane;
  try {
    if (staticMode) await (await browserBackend()).closeDocument(id);
    else await fetch(`/api/document?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  catch { /* La sesión del navegador se cierra igualmente. */ }
  app.docs.delete(id); app.order = app.order.filter((item) => item !== id);
  (staticMode ? localStorage : sessionStorage).removeItem("editor-pdf-" + id);
  for (const pane of panes) if (pane.docId === id) { pane.docId = null; pane.loadedKey = null; }
  if (!panes[0].docId) panes[0].docId = app.order.find((item) => item !== panes[1].docId) || app.order[0] || null;
  if (app.split && !panes[1].docId) panes[1].docId = app.order.find((item) => item !== panes[0].docId) || null;
  if (app.order.length < 2) app.split = false;
  app.activePane = app.split && panes[previousPane].docId ? previousPane : 0;
  renderAll(); status(`${doc.name} cerrado`);
}
async function openFiles(files) {
  const selected = Array.from(files || []); if (!selected.length) return;
  try { await ensureBackend(); }
  catch (error) { status(error.message); alert(error.message); return; }
  let opened = 0;
  for (const file of selected) {
    try {
      status(`Abriendo ${file.name}…`);
      const buffer = await file.arrayBuffer();
      const hash = await sha256(buffer);
      let info;
      if (staticMode) info = await (await browserBackend()).openDocument(file, buffer, hash);
      else {
        const response = await fetch("/api/open", { method: "POST", headers: {
          "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name),
          "X-File-Modified": String(file.lastModified || 0) }, body: buffer });
        if (!response.ok) throw new Error(await responseError(response));
        info = await response.json();
      }
      if (!info.id || !Array.isArray(info.pages)) throw new Error("Respuesta incompatible del servidor. Vuelve a iniciar el editor con ABRIR_EDITOR.cmd.");
      const doc = newDoc(info, hash);
      app.docs.set(doc.id, doc); app.order.push(doc.id); persist(doc); opened++;
      if (!panes[0].docId) panes[0].docId = doc.id;
      else if (!panes[1].docId) { panes[1].docId = doc.id; app.split = true; app.activePane = 1; }
      else panes[app.activePane].docId = doc.id;
      renderAll();
    } catch (error) { status(`Error en ${file.name}: ${error.message}`); }
  }
  if (opened) { requestAnimationFrame(() => panes.forEach((pane, index) => { if (index === 0 || app.split) fitPane(index); }));
    status(`${opened} PDF${opened === 1 ? "" : "s"} abierto${opened === 1 ? "" : "s"} · ${app.order.length} en la sesión`); }
}
async function restoreSession() {
  try {
    await ensureBackend();
    let data;
    if (staticMode) data = { documents: await (await browserBackend()).listDocuments() };
    else {
      const response = await fetch("/api/documents"); if (!response.ok) return;
      data = await response.json();
    }
    for (const info of data.documents) {
      const doc = newDoc(info, "");
      try {
        const stored = JSON.parse((staticMode ? localStorage : sessionStorage).getItem("editor-pdf-" + doc.id) || "null");
        if (stored?.layers?.length && Array.isArray(stored.marks)) {
          doc.layers = stored.layers; doc.marks = stored.marks;
          doc.activeLayerId = stored.activeLayerId || stored.layers[0].id;
          doc.hash = stored.hash || doc.hash; doc.page = clamp(stored.page || 0, 0, doc.pages.length - 1);
          doc.zoom = clamp(stored.zoom || 1, 0.25, 5);
          doc.inkWidth = clamp(stored.inkWidth || 3, 1, 12);
          doc.inkColor = validInkColor(stored.inkColor,
            doc.layers.find((layer) => layer.id === doc.activeLayerId && layer.role === "ink")?.color || "#d44332");
        }
      } catch { /* Se abre el documento sin la copia de sesión dañada. */ }
      app.docs.set(doc.id, doc); app.order.push(doc.id);
    }
    panes[0].docId = app.order[0] || null;
    if (app.order.length > 1) { panes[1].docId = app.order[1]; app.split = true; }
    renderAll();
    if (app.order.length) status(`${app.order.length} PDF abiertos en esta sesión`);
  } catch (error) { status(error.message); }
}

function renderPane(index) {
  const pane = panes[index]; const doc = docFor(index);
  pane.root.hidden = index === 1 && !app.split;
  if (pane.root.hidden) return;
  pane.name.textContent = doc?.name || (index === 0 ? "Ningún documento abierto" : "Selecciona otro PDF");
  pane.name.title = doc?.name || "";
  pane.empty.hidden = !!doc; pane.stage.hidden = !doc;
  pane.pageInfo.textContent = doc ? `${doc.page + 1} / ${doc.pages.length}` : "0 / 0";
  pane.zoomLabel.textContent = doc ? `${Math.round(doc.zoom * 100)}%` : "100%";
  $("prev" + pane.suffix).disabled = !doc || doc.page <= 0;
  $("next" + pane.suffix).disabled = !doc || doc.page >= doc.pages.length - 1;
  for (const prefix of ["zoomOut", "zoomIn", "fit"]) $(prefix + pane.suffix).disabled = !doc;
  pane.viewport.classList.remove("hand", "highlight", "ink", "callout", "select", "erase");
  pane.viewport.classList.add(app.temporaryHand ? "hand" : app.tool);
  if (!doc) { clearPaneImage(pane); pane.overlay.replaceChildren(); return; }
  updateStageSize(index); renderMarks(index);
  const key = `${doc.id}:${doc.page}`;
  if (pane.loadedKey !== key) loadPage(index);
  else scheduleDetail(index);
}
function clearPaneDetail(pane) {
  clearTimeout(pane.detailTimer);
  pane.detailToken++;
  pane.detailRegion = null;
  pane.detailImage.hidden = true;
  pane.detailImage.removeAttribute("src");
  if (pane.detailUrl) URL.revokeObjectURL(pane.detailUrl);
  pane.detailUrl = null;
}
function clearPaneImage(pane) {
  clearPaneDetail(pane);
  pane.image.removeAttribute("src");
  if (pane.imageUrl) URL.revokeObjectURL(pane.imageUrl);
  pane.imageUrl = null;
}
async function loadPage(index) {
  const pane = panes[index]; const doc = docFor(index); if (!doc) return;
  const key = `${doc.id}:${doc.page}`; pane.loadedKey = key;
  const token = ++pane.renderToken;
  clearPaneImage(pane);
  try {
    let blob;
    if (staticMode) blob = await (await browserBackend()).renderPage(doc.id, doc.page);
    else {
      const response = await fetch(`/api/page?id=${encodeURIComponent(doc.id)}&page=${doc.page}`);
      if (!response.ok) throw new Error(await responseError(response));
      blob = await response.blob();
    }
    if (token !== pane.renderToken || pane.docId !== doc.id || pane.loadedKey !== key) return;
    const url = URL.createObjectURL(blob);
    pane.imageUrl = url;
    pane.image.src = url;
    pane.viewport.scrollTop = 0; pane.viewport.scrollLeft = 0;
    scheduleDetail(index);
  } catch (error) { pane.loadedKey = null; status(`Error al mostrar ${doc.name}: ${error.message}`); }
}
function scheduleDetail(index) {
  const pane = panes[index];
  clearTimeout(pane.detailTimer);
  pane.detailTimer = setTimeout(() => renderDetail(index), 140);
}
async function renderDetail(index) {
  const pane = panes[index], doc = docFor(index);
  if (!doc || pane.root.hidden || pane.stage.hidden) return;
  const size = doc.pages[doc.page];
  const baseScale = Math.min(2, (staticMode ? 4096 : 5000) / Math.max(size.width, size.height));
  const requestedScale = doc.zoom * Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  if (requestedScale <= baseScale * 1.1) { clearPaneDetail(pane); return; }
  const stage = pane.stage.getBoundingClientRect(), viewport = pane.viewport.getBoundingClientRect();
  const x0 = clamp((viewport.left - stage.left) / doc.zoom, 0, size.width);
  const y0 = clamp((viewport.top - stage.top) / doc.zoom, 0, size.height);
  const x1 = clamp((viewport.right - stage.left) / doc.zoom, 0, size.width);
  const y1 = clamp((viewport.bottom - stage.top) / doc.zoom, 0, size.height);
  if (x1 <= x0 || y1 <= y0) return;
  const previous = pane.detailRegion;
  if (previous && previous.docId === doc.id && previous.page === doc.page &&
      Math.abs(previous.requestedScale - requestedScale) < 0.01 &&
      previous.x <= x0 + 3 && previous.y <= y0 + 3 &&
      previous.x + previous.width >= x1 - 3 && previous.y + previous.height >= y1 - 3) return;
  const padding = 120 / doc.zoom;
  const x = Math.max(0, Math.floor(x0 - padding)), y = Math.max(0, Math.floor(y0 - padding));
  const right = Math.min(size.width, Math.ceil(x1 + padding));
  const bottom = Math.min(size.height, Math.ceil(y1 + padding));
  const width = right - x, height = bottom - y;
  const scale = Math.min(requestedScale, 4096 / width, 4096 / height,
    Math.sqrt(12_000_000 / (width * height)));
  if (scale <= baseScale * 1.05) { clearPaneDetail(pane); return; }
  const token = ++pane.detailToken, key = `${doc.id}:${doc.page}`;
  try {
    let blob;
    if (staticMode) blob = await (await browserBackend()).renderPage(doc.id, doc.page,
      { x, y, width, height, scale });
    else {
      const query = new URLSearchParams({ id: doc.id, page: String(doc.page),
        x: String(x), y: String(y), width: String(width), height: String(height), scale: String(scale) });
      const response = await fetch(`/api/page?${query}`);
      if (!response.ok) throw new Error(await responseError(response));
      blob = await response.blob();
    }
    if (token !== pane.detailToken || pane.docId !== doc.id || pane.loadedKey !== key ||
        Math.abs(doc.zoom - requestedScale / Math.min(2.5, Math.max(1, window.devicePixelRatio || 1))) > 0.01) return;
    const url = URL.createObjectURL(blob);
    const oldUrl = pane.detailUrl;
    pane.detailUrl = url;
    pane.detailImage.style.left = `${x * doc.zoom}px`;
    pane.detailImage.style.top = `${y * doc.zoom}px`;
    pane.detailImage.style.width = `${width * doc.zoom}px`;
    pane.detailImage.style.height = `${height * doc.zoom}px`;
    pane.detailImage.src = url;
    pane.detailImage.hidden = false;
    pane.detailRegion = { docId: doc.id, page: doc.page, x, y, width, height, scale, requestedScale };
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  } catch (error) {
    if (token === pane.detailToken) status(`No se pudo mejorar la imagen HD: ${error.message}`);
  }
}
function updateStageSize(index) {
  const pane = panes[index], doc = docFor(index); if (!doc) return;
  const size = doc.pages[doc.page];
  pane.stage.style.width = `${size.width * doc.zoom}px`;
  pane.stage.style.height = `${size.height * doc.zoom}px`;
  pane.overlay.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  pane.zoomLabel.textContent = `${Math.round(doc.zoom * 100)}%`;
}
function setZoom(index, value, clientX, clientY, save = true) {
  const pane = panes[index], doc = docFor(index); if (!doc) return;
  const next = clamp(value, 0.25, 5); if (Math.abs(next - doc.zoom) < 0.001) return;
  const before = pane.stage.getBoundingClientRect();
  const viewport = pane.viewport.getBoundingClientRect();
  const x = clientX ?? viewport.left + pane.viewport.clientWidth / 2;
  const y = clientY ?? viewport.top + pane.viewport.clientHeight / 2;
  const docX = (x - before.left) / doc.zoom, docY = (y - before.top) / doc.zoom;
  doc.zoom = next; clearPaneDetail(pane); updateStageSize(index);
  const after = pane.stage.getBoundingClientRect();
  pane.viewport.scrollLeft += after.left + docX * next - x;
  pane.viewport.scrollTop += after.top + docY * next - y;
  if (save) persist(doc);
  scheduleDetail(index);
}
function fitPane(index) {
  const pane = panes[index], doc = docFor(index); if (!doc || pane.root.hidden) return;
  const size = doc.pages[doc.page];
  doc.zoom = clamp(Math.min(Math.max(100, pane.viewport.clientWidth - 44) / size.width,
                            Math.max(100, pane.viewport.clientHeight - 44) / size.height), 0.25, 5);
  clearPaneDetail(pane); updateStageSize(index);
  pane.viewport.scrollTop = 0; pane.viewport.scrollLeft = 0; persist(doc); scheduleDetail(index);
}
function changePage(index, step) {
  const doc = docFor(index); if (!doc) return;
  const next = clamp(doc.page + step, 0, doc.pages.length - 1); if (next === doc.page) return;
  doc.page = next; doc.selectedMarkId = null; persist(doc); renderAll();
}

function svg(tag) { return document.createElementNS(SVG, tag); }
function svgArrowDefs(index) {
  const defs = svg("defs"), marker = svg("marker"), path = svg("path");
  marker.id = "arrow-" + index; marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "8"); marker.setAttribute("markerHeight", "8");
  marker.setAttribute("orient", "auto-start-reverse");
  path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); path.setAttribute("fill", "#b8362a");
  marker.append(path); defs.append(marker); return defs;
}
function drawHighlight(mark, layer, selected = false, preview = false) {
  const rect = svg("rect");
  rect.setAttribute("x", mark.x0); rect.setAttribute("y", mark.y0);
  rect.setAttribute("width", mark.x1 - mark.x0); rect.setAttribute("height", mark.y1 - mark.y0);
  rect.setAttribute("fill", layer?.color || "#ffe45c");
  rect.setAttribute("fill-opacity", String(layer?.opacity ?? 0.35));
  rect.setAttribute("stroke", selected ? "#135f9a" : "none"); rect.setAttribute("stroke-width", "1.5");
  if (preview) rect.classList.add("preview"); else rect.dataset.markId = mark.id;
  return rect;
}
function drawCallout(mark, selected, index) {
  const group = svg("g"); group.classList.add("callout"); group.dataset.markId = mark.id;
  const line = svg("line");
  line.setAttribute("x1", mark.boxX + mark.boxW / 2); line.setAttribute("y1", mark.boxY + mark.boxH / 2);
  line.setAttribute("x2", mark.tipX); line.setAttribute("y2", mark.tipY);
  line.setAttribute("stroke", "#b8362a"); line.setAttribute("stroke-width", "1.6");
  line.setAttribute("marker-end", `url(#arrow-${index})`);
  const box = svg("rect"); box.setAttribute("x", mark.boxX); box.setAttribute("y", mark.boxY);
  box.setAttribute("width", mark.boxW); box.setAttribute("height", mark.boxH);
  box.setAttribute("rx", "3"); box.setAttribute("fill", "#fffefa"); box.setAttribute("fill-opacity", "0.96");
  box.setAttribute("stroke", selected ? "#135f9a" : "#b8362a"); box.setAttribute("stroke-width", selected ? "2" : "1");
  const label = svg("text"); label.setAttribute("x", mark.boxX + 8); label.setAttribute("y", mark.boxY + 15);
  label.setAttribute("fill", "#213040"); label.setAttribute("font-size", "11");
  mark.text.split("\n").forEach((lineText, lineIndex) => {
    const span = svg("tspan"); span.setAttribute("x", mark.boxX + 8);
    if (lineIndex) span.setAttribute("dy", "14"); span.textContent = lineText; label.append(span);
  });
  group.append(line, box, label); return group;
}
function drawInk(mark, layer, selected = false, preview = false) {
  const group = svg("g"); group.classList.add("ink");
  if (!preview) group.dataset.markId = mark.id; else group.classList.add("preview");
  const points = mark.points;
  if (points.length === 1) {
    const dot = svg("circle"); dot.setAttribute("cx", points[0][0]); dot.setAttribute("cy", points[0][1]);
    dot.setAttribute("r", Math.max(0.8, mark.width / 2));
    dot.setAttribute("fill", layer.color); dot.setAttribute("fill-opacity", String(layer.opacity));
    if (selected) { dot.setAttribute("stroke", "#135f9a"); dot.setAttribute("stroke-width", "1.5"); }
    group.append(dot);
  } else {
    const coords = points.map((point) => point.join(",")).join(" ");
    if (selected) { const halo = svg("polyline"); halo.setAttribute("points", coords);
      halo.setAttribute("fill", "none"); halo.setAttribute("stroke", "#135f9a");
      halo.setAttribute("stroke-width", mark.width + 3); halo.setAttribute("stroke-linejoin", "round");
      halo.setAttribute("stroke-linecap", "round"); group.append(halo); }
    const line = svg("polyline"); line.setAttribute("points", coords); line.setAttribute("fill", "none");
    line.setAttribute("stroke", layer.color); line.setAttribute("stroke-opacity", String(layer.opacity));
    line.setAttribute("stroke-width", mark.width); line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round"); group.append(line);
  }
  return group;
}
function renderMarks(index) {
  const pane = panes[index], doc = docFor(index); pane.overlay.replaceChildren(); if (!doc) return;
  pane.overlay.append(svgArrowDefs(index));
  for (const mark of doc.marks) {
    const layer = doc.layers.find((item) => item.id === mark.layerId);
    if (mark.page !== doc.page || !layer?.visible) continue;
    pane.overlay.append(mark.kind === "callout" ? drawCallout(mark, mark.id === doc.selectedMarkId, index)
      : mark.kind === "ink" ? drawInk(mark, layer, mark.id === doc.selectedMarkId)
        : drawHighlight(mark, layer, mark.id === doc.selectedMarkId));
  }
}
function renderLayers() {
  const doc = currentDoc(); ui.layers.replaceChildren(); if (!doc) return;
  for (const layer of doc.layers) {
    const row = document.createElement("div"); row.className = "layer" + (layer.id === doc.activeLayerId ? " active" : "");
    const top = document.createElement("div"); top.className = "layer-top";
    const pick = document.createElement("button"); pick.className = "layer-pick";
    pick.title = "Seleccionar capa de " + doc.name;
    pick.textContent = `${layer.name} · ${doc.marks.filter((mark) => mark.layerId === layer.id).length} marcas`;
    pick.onclick = () => {
      doc.activeLayerId = layer.id;
      if (layer.role === "ink") doc.inkColor = validInkColor(layer.color);
      persist(doc); renderLayers(); renderButtons();
    };
    const eye = document.createElement("button"); eye.className = "eye" + (layer.visible ? "" : " off");
    eye.textContent = layer.visible ? "◉" : "○"; eye.title = layer.visible ? "Ocultar capa" : "Mostrar capa";
    eye.onclick = () => mutate(doc, () => { layer.visible = !layer.visible; });
    top.append(pick, eye);
    const bottom = document.createElement("div"); bottom.className = "layer-bottom";
    const color = document.createElement("input"); color.type = "color"; color.value = layer.color;
    color.title = layer.role === "ink" ? "Color del dibujo" : "Color del resaltado";
    color.onchange = () => mutate(doc, () => {
      layer.color = color.value;
      if (layer.role === "ink" && doc.activeLayerId === layer.id) doc.inkColor = color.value;
    });
    const opacity = document.createElement("input"); opacity.type = "range"; opacity.min = "5"; opacity.max = "100";
    opacity.value = String(Math.round(layer.opacity * 100)); opacity.title = "Opacidad de la capa";
    opacity.onchange = () => mutate(doc, () => { layer.opacity = Number(opacity.value) / 100; });
    const percent = document.createElement("small"); percent.textContent = `${Math.round(layer.opacity * 100)}%`;
    const actions = document.createElement("div"); actions.className = "layer-actions";
    const rename = document.createElement("button"); rename.textContent = "✎"; rename.title = "Renombrar capa";
    rename.onclick = () => { const value = prompt("Nombre de la capa:", layer.name); if (value?.trim()) mutate(doc, () => { layer.name = value.trim().slice(0, 80); }); };
    const remove = document.createElement("button"); remove.textContent = "×"; remove.title = "Eliminar capa y sus marcas";
    remove.disabled = doc.layers.length === 1;
    remove.onclick = () => mutate(doc, () => {
      doc.layers = doc.layers.filter((item) => item.id !== layer.id);
      doc.marks = doc.marks.filter((mark) => mark.layerId !== layer.id);
      if (doc.activeLayerId === layer.id) doc.activeLayerId = doc.layers[0].id;
      doc.selectedMarkId = null;
    });
    actions.append(rename, remove); bottom.append(color, opacity, percent, actions); row.append(top, bottom); ui.layers.append(row);
  }
}
function renderButtons() {
  const doc = currentDoc();
  $("sideDocName").textContent = doc?.name || "Ningún PDF seleccionado";
  $("sideDocName").title = doc?.name || "";
  $("undo").disabled = !doc?.undo.length; $("redo").disabled = !doc?.redo.length;
  $("saveProject").disabled = !doc; $("openProject").disabled = !doc;
  $("exportPdf").disabled = !doc; $("exportAll").disabled = !app.order.length;
  $("deleteMark").disabled = !doc?.selectedMarkId; $("clearMarks").disabled = !doc?.marks.length;
  $("addLayer").disabled = !doc;
  $("markCount").textContent = `${doc?.marks.length || 0} marca${doc?.marks.length === 1 ? "" : "s"}`;
  $("splitToggle").disabled = !app.order.length;
  $("splitToggle").classList.toggle("active", app.split);
  $("closeCurrent").disabled = !doc;
  $("inkOptions").hidden = app.tool !== "ink";
  $("inkColor").disabled = !doc; $("inkWidth").disabled = !doc;
  $("inkColor").value = doc?.inkColor || "#d44332";
  $("inkWidth").value = String(doc?.inkWidth || 3);
  $("inkWidthLabel").textContent = String(doc?.inkWidth || 3);
  for (const tool of ["Hand", "Highlight", "Ink", "Callout", "Select", "Erase"])
    $("tool" + tool).classList.toggle("active", app.tool === tool.toLowerCase());
  panes.forEach((pane, index) => pane.root.classList.toggle("active-pane", index === app.activePane));
}
function renderAll() { renderTabs(); panes.forEach((_, index) => renderPane(index)); renderLayers(); renderButtons(); }
function setTool(tool) {
  app.tool = tool; app.temporaryHand = false; renderAll();
  const labels = { hand: "Arrastra para mover el PDF", highlight: "Arrastra para resaltar",
    ink: "Elige color y grosor; cada color del lápiz se guarda en una capa de dibujo propia",
    callout: "Arrastra desde el punto señalado hasta donde irá el texto", select: "Haz clic en una marca para seleccionarla",
    erase: "Haz clic en una marca para borrarla del PDF activo · Ctrl+Z para deshacer" };
  status(labels[tool]);
}
function effectiveTool() { return app.temporaryHand ? "hand" : app.tool; }
function pointOnPage(event, index) {
  const pane = panes[index], doc = docFor(index), rect = pane.stage.getBoundingClientRect();
  const size = doc.pages[doc.page];
  return { x: clamp((event.clientX - rect.left) / doc.zoom, 0, size.width),
    y: clamp((event.clientY - rect.top) / doc.zoom, 0, size.height) };
}
function insidePage(event, index) {
  const rect = panes[index].stage.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}
function normalizedRect(a, b) {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}
function appendInkPoint(points, point) {
  const previous = points[points.length - 1];
  if (!previous || Math.hypot(point.x - previous[0], point.y - previous[1]) >= 0.7)
    if (points.length < 2200) points.push([point.x, point.y]);
}
function smoothInk(points) {
  if (points.length < 3) return points;
  let result = points;
  for (let iteration = 0; iteration < 2; iteration++) {
    const next = [result[0]];
    for (let index = 0; index < result.length - 1; index++) {
      const a = result[index], b = result[index + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(result[result.length - 1]); result = next;
  }
  return result;
}
function wrapText(text, max = 28) {
  const lines = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + word).length > max) { lines.push(line); line = ""; }
      if (word.length > max) {
        if (line) { lines.push(line); line = ""; }
        for (let i = 0; i < word.length; i += max) lines.push(word.slice(i, i + max));
      } else line = line ? line + " " + word : word;
    }
    if (line) lines.push(line);
  }
  return lines;
}
function touchPair(pane) {
  const [a, b] = Array.from(pane.touchPoints.values()).slice(0, 2);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
}
function pointerDown(event, index) {
  activatePane(index);
  const pane = panes[index], doc = docFor(index);
  if (!doc || (event.pointerType !== "touch" && event.button !== 0)) return;
  if (event.pointerType === "touch") {
    pane.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pane.viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (pane.touchPoints.size >= 2) {
      pane.interaction = null;
      pane.viewport.classList.remove("dragging");
      pane.pinch = touchPair(pane);
      pane.ignoreTouchUntilClear = true;
      renderMarks(index);
      return;
    }
    if (pane.ignoreTouchUntilClear) return;
  }
  const tool = effectiveTool();
  if (tool === "hand") {
    pane.interaction = { kind: "pan", x: event.clientX, y: event.clientY,
      left: pane.viewport.scrollLeft, top: pane.viewport.scrollTop, pointerId: event.pointerId };
    pane.viewport.classList.add("dragging"); pane.viewport.setPointerCapture(event.pointerId); event.preventDefault();
  } else if ((tool === "highlight" || tool === "callout" || tool === "ink") && insidePage(event, index)) {
    const start = pointOnPage(event, index);
    pane.interaction = { kind: tool, start, end: start, points: [[start.x, start.y]],
      width: doc.inkWidth, color: doc.inkColor, docId: doc.id, page: doc.page,
      pointerId: event.pointerId };
    pane.viewport.setPointerCapture(event.pointerId); event.preventDefault();
  } else if (event.pointerType === "touch" && (tool === "select" || tool === "erase")) {
    pane.interaction = { kind: "tap", tool, pointerId: event.pointerId, docId: doc.id,
      markId: event.target.closest?.("[data-mark-id]")?.dataset.markId || null,
      x: event.clientX, y: event.clientY };
  } else if (tool === "select") {
    doc.selectedMarkId = event.target.closest?.("[data-mark-id]")?.dataset.markId || null;
    renderMarks(index); renderButtons();
  } else if (tool === "erase") {
    const id = event.target.closest?.("[data-mark-id]")?.dataset.markId;
    if (id) { event.preventDefault(); eraseMark(doc, id); }
  }
}
function pointerMove(event, index) {
  const pane = panes[index];
  if (event.pointerType === "touch" && pane.touchPoints.has(event.pointerId)) {
    pane.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pane.pinch && pane.touchPoints.size >= 2) {
      const next = touchPair(pane), previous = pane.pinch, doc = docFor(index);
      pane.viewport.scrollLeft -= next.x - previous.x;
      pane.viewport.scrollTop -= next.y - previous.y;
      if (doc) setZoom(index, doc.zoom * next.distance / previous.distance, next.x, next.y, false);
      pane.pinch = next;
      event.preventDefault();
      return;
    }
    if (pane.ignoreTouchUntilClear) return;
  }
  const interaction = pane.interaction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  if (interaction.kind === "tap") return;
  if (interaction.kind === "pan") {
    pane.viewport.scrollLeft = interaction.left - (event.clientX - interaction.x);
    pane.viewport.scrollTop = interaction.top - (event.clientY - interaction.y);
    return;
  }
  interaction.end = pointOnPage(event, index);
  if (interaction.kind === "ink") {
    for (const sample of (event.getCoalescedEvents?.() || [event]))
      appendInkPoint(interaction.points, pointOnPage(sample, index));
    renderMarks(index);
    const layer = docFor(index).layers.find((item) => item.role === "ink" && item.color.toLowerCase() === interaction.color);
    pane.overlay.append(drawInk({ points: interaction.points, width: interaction.width },
      layer || { color: interaction.color, opacity: 1 }, false, true));
    return;
  }
  renderMarks(index);
  if (interaction.kind === "highlight") {
    pane.overlay.append(drawHighlight(normalizedRect(interaction.start, interaction.end), activeLayer(docFor(index)), false, true));
  } else {
    const line = svg("line"); line.classList.add("preview");
    line.setAttribute("x1", interaction.end.x); line.setAttribute("y1", interaction.end.y);
    line.setAttribute("x2", interaction.start.x); line.setAttribute("y2", interaction.start.y);
    line.setAttribute("stroke", "#b8362a"); line.setAttribute("stroke-width", "1.8");
    line.setAttribute("marker-end", `url(#arrow-${index})`); pane.overlay.append(line);
  }
}
function pointerUp(event, index) {
  const pane = panes[index];
  if (event.pointerType === "touch") {
    pane.touchPoints.delete(event.pointerId);
    if (pane.pinch || pane.ignoreTouchUntilClear) {
      if (pane.touchPoints.size < 2) pane.pinch = null;
      pane.ignoreTouchUntilClear = pane.touchPoints.size > 0;
      if (!pane.pinch && !pane.ignoreTouchUntilClear && docFor(index)) persist(docFor(index));
      if (pane.viewport.hasPointerCapture(event.pointerId)) pane.viewport.releasePointerCapture(event.pointerId);
      return;
    }
  }
  const interaction = pane.interaction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  pane.interaction = null; pane.viewport.classList.remove("dragging");
  if (pane.viewport.hasPointerCapture(event.pointerId)) pane.viewport.releasePointerCapture(event.pointerId);
  if (interaction.kind === "pan") return;
  if (interaction.kind === "tap") {
    const doc = app.docs.get(interaction.docId);
    if (doc && Math.hypot(event.clientX - interaction.x, event.clientY - interaction.y) < 14) {
      if (interaction.tool === "erase" && interaction.markId) eraseMark(doc, interaction.markId);
      else if (interaction.tool === "select") {
        doc.selectedMarkId = interaction.markId;
        renderMarks(index); renderButtons();
      }
    }
    return;
  }
  const doc = app.docs.get(interaction.docId);
  if (!doc || docFor(index)?.id !== doc.id || doc.page !== interaction.page) { renderMarks(index); return; }
  const end = pointOnPage(event, index);
  if (interaction.kind === "ink") {
    appendInkPoint(interaction.points, end);
    const points = smoothInk(interaction.points);
    mutate(doc, () => {
      let layer = activeLayer(doc);
      if (layer?.role !== "ink" || layer.color.toLowerCase() !== interaction.color)
        layer = doc.layers.find((item) => item.role === "ink" && item.color.toLowerCase() === interaction.color);
      if (!layer) { layer = newInkLayer(doc, interaction.color); doc.layers.push(layer); }
      layer.visible = true; doc.activeLayerId = layer.id;
      doc.marks.push({ id: crypto.randomUUID(), kind: "ink", page: doc.page,
        layerId: layer.id, points, width: interaction.width });
    });
    status(`Dibujo añadido a ${activeLayer(doc).name}`);
  } else if (interaction.kind === "highlight") {
    const rect = normalizedRect(interaction.start, end);
    if (rect.x1 - rect.x0 < 2 || rect.y1 - rect.y0 < 2) { renderMarks(index); return; }
    mutate(doc, () => {
      let layer = activeLayer(doc);
      if (layer?.role === "ink") layer = doc.layers.find((item) => item.role !== "ink");
      if (!layer) { layer = defaultLayer(doc.layers.length + 1); doc.layers.push(layer); }
      layer.visible = true; doc.activeLayerId = layer.id;
      doc.marks.push({ id: crypto.randomUUID(), kind: "highlight", page: doc.page, layerId: layer.id, ...rect });
    });
    status(`Resaltado añadido a ${activeLayer(doc).name}`);
  } else {
    if (Math.hypot(end.x - interaction.start.x, end.y - interaction.start.y) < 10) { renderMarks(index); return; }
    const value = prompt("Texto de revisión:");
    if (!value?.trim()) { renderMarks(index); return; }
    const text = wrapText(value.trim().slice(0, 300)).join("\n");
    const size = doc.pages[doc.page], boxW = Math.min(190, size.width - 8);
    const boxH = Math.min(size.height - 8, Math.max(38, text.split("\n").length * 14 + 14));
    if (boxW < 60 || boxH < 25) { status("La página es demasiado pequeña para agregar texto."); renderMarks(index); return; }
    mutate(doc, () => {
      activeLayer(doc).visible = true;
      doc.marks.push({ id: crypto.randomUUID(), kind: "callout", page: doc.page,
        layerId: doc.activeLayerId, tipX: interaction.start.x, tipY: interaction.start.y,
        boxX: clamp(end.x, 0, size.width - boxW), boxY: clamp(end.y, 0, size.height - boxH),
        boxW, boxH, text });
    });
    status(`Texto con flecha añadido a ${activeLayer(doc).name}`);
  }
}

function projectPayload(doc) { return { id: doc.id, layers: doc.layers, marks: doc.marks }; }
function offerBrowserExport(blob, filename, mime) {
  return new Promise((resolve) => {
    const shade = document.createElement("div");
    shade.className = "export-shade";
    shade.innerHTML = `<div class="export-dialog" role="dialog" aria-modal="true" aria-label="Guardar archivo">
      <h2>Archivo preparado</h2><p></p><div class="export-dialog-actions"></div></div>`;
    shade.querySelector("p").textContent = filename;
    const actions = shade.querySelector(".export-dialog-actions");
    const finish = (result) => { shade.remove(); resolve(result); };
    const addButton = (label, action, primary = false) => {
      const button = document.createElement("button");
      button.textContent = label;
      if (primary) button.className = "primary";
      button.onclick = action;
      actions.append(button);
      return button;
    };
    if (navigator.share && navigator.canShare) {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        const share = addButton("Compartir / Guardar en Archivos", async () => {
          share.disabled = true;
          try {
            await navigator.share({ files: [file], title: filename });
            finish({ saved: true, path: "Compartir / Guardar en Archivos" });
          } catch (error) {
            if (error.name === "AbortError") finish({ saved: false });
            else { share.disabled = false; status(`No se pudo compartir: ${error.message}`); }
          }
        }, true);
      }
    }
    addButton("Descargar", () => { downloadBlob(blob, filename); finish({ saved: true, path: filename }); });
    addButton("Cancelar", () => finish({ saved: false }));
    document.body.append(shade);
    actions.querySelector("button").focus();
  });
}
async function saveExport(endpoint, payload, filename, mime, extension) {
  if (staticMode) {
    let handle;
    if (typeof window.showSaveFilePicker === "function") {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: filename,
          types: [{ description: extension === ".pdf" ? "Documento PDF" : "Archivo ZIP",
            accept: { [mime]: [extension] } }] });
      } catch (error) { if (error.name === "AbortError") return { saved: false }; }
    }
    const backend = await browserBackend();
    const blob = endpoint === "/api/export-all" ? await backend.exportAll(payload) : await backend.exportDocument(payload);
    if (handle) {
      const writable = await handle.createWritable();
      try { await writable.write(blob); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
      return { saved: true, path: handle.name || filename };
    }
    return offerBrowserExport(blob, filename, mime);
  }
  const body = JSON.stringify(payload);
  if (typeof window.showSaveFilePicker === "function") {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: filename,
        types: [{ description: extension === ".pdf" ? "Documento PDF" : "Archivo ZIP",
          accept: { [mime]: [extension] } }] });
    } catch (error) {
      if (error.name === "AbortError") return { saved: false };
      // Algunos navegadores integrados exponen la API sin permitir el diálogo.
    }
    if (handle) {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!response.ok) throw new Error(await responseError(response));
      const writable = await handle.createWritable();
      try { await writable.write(await response.blob()); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
      return { saved: true, path: handle.name || filename };
    }
  }
  const response = await fetch(endpoint + "-save", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}
async function exportPdf() {
  const doc = currentDoc(); if (!doc) return;
  try {
    status(`Elige dónde guardar ${doc.name}…`);
    const name = doc.name.replace(/\.pdf$/i, "") + "_marcado.pdf";
    const result = await saveExport("/api/export", projectPayload(doc), name, "application/pdf", ".pdf");
    status(result.saved ? `PDF guardado: ${result.path}` : "Exportación cancelada");
  } catch (error) { status(`Error: ${error.message}`); }
}
async function exportAll() {
  if (!app.order.length) return;
  try {
    status(`Elige dónde guardar ${app.order.length} PDF…`);
    const result = await saveExport("/api/export-all", app.order.map((id) => projectPayload(app.docs.get(id))),
      "PDFs_marcados.zip", "application/zip", ".zip");
    status(result.saved ? `${app.order.length} PDF guardados: ${result.path}` : "Exportación cancelada");
  } catch (error) { status(`Error: ${error.message}`); }
}
function saveProject() {
  const doc = currentDoc(); if (!doc) return;
  const payload = { version: 2, sourceName: doc.name, sha256: doc.hash, pages: doc.pages,
    layers: doc.layers, marks: doc.marks, inkColor: doc.inkColor, inkWidth: doc.inkWidth };
  const name = doc.name.replace(/\.pdf$/i, "") + "_capas.json";
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), name);
  status(`Proyecto guardado: ${name}`);
}
async function openProject(file) {
  const doc = currentDoc(); if (!file || !doc) return;
  try {
    const project = JSON.parse(await file.text());
    if (![1, 2].includes(project.version) || !doc.hash || project.sha256 !== doc.hash)
      throw new Error("Este proyecto pertenece a otro PDF. Abre su PDF original.");
    if (!Array.isArray(project.layers) || !project.layers.length || !Array.isArray(project.marks))
      throw new Error("El proyecto no contiene capas válidas.");
    for (const mark of project.marks) {
      const size = doc.pages[mark.page];
      if (!size || !project.layers.some((layer) => layer.id === mark.layerId)) throw new Error("El proyecto contiene marcas inválidas.");
      if (mark.kind === "ink") {
        if (!Array.isArray(mark.points) || !mark.points.length || mark.points.length > 10000 ||
            !Number.isFinite(mark.width) || mark.width < 0.5 || mark.width > 20 ||
            mark.points.some((point) => !Array.isArray(point) || point.length !== 2 ||
              !point.every(Number.isFinite) || point[0] < 0 || point[1] < 0 ||
              point[0] > size.width + 0.01 || point[1] > size.height + 0.01))
          throw new Error("El proyecto contiene dibujos inválidos.");
      } else if (mark.kind === "callout") {
        if (!mark.text || ![mark.tipX, mark.tipY, mark.boxX, mark.boxY, mark.boxW, mark.boxH].every(Number.isFinite) ||
            mark.tipX < 0 || mark.tipY < 0 || mark.tipX > size.width || mark.tipY > size.height ||
            mark.boxX < 0 || mark.boxY < 0 || mark.boxW < 60 || mark.boxH < 25 ||
            mark.boxX + mark.boxW > size.width + 0.01 || mark.boxY + mark.boxH > size.height + 0.01)
          throw new Error("El proyecto contiene textos fuera de la página.");
      } else if (![mark.x0, mark.y0, mark.x1, mark.y1].every(Number.isFinite) ||
                 mark.x0 < 0 || mark.y0 < 0 || mark.x0 >= mark.x1 || mark.y0 >= mark.y1 ||
                 mark.x1 > size.width + 0.01 || mark.y1 > size.height + 0.01)
        throw new Error("El proyecto contiene resaltados fuera de la página.");
    }
    mutate(doc, () => { doc.layers = project.layers; doc.marks = project.marks;
      doc.activeLayerId = project.layers[0].id; doc.selectedMarkId = null; });
    doc.inkColor = validInkColor(project.inkColor,
      doc.layers.find((layer) => layer.role === "ink")?.color || "#d44332");
    if (Number.isFinite(project.inkWidth)) doc.inkWidth = clamp(project.inkWidth, 1, 12);
    persist(doc); renderButtons();
    status(`${doc.marks.length} marcas cargadas en ${doc.name}`);
  } catch (error) { status(`Error: ${error.message}`); }
}

$("openPdf").onclick = $("emptyOpen").onclick = () => ui.pdfInput.click();
ui.pdfInput.onchange = () => { openFiles(ui.pdfInput.files); ui.pdfInput.value = ""; };
$("openProject").onclick = () => ui.projectInput.click();
ui.projectInput.onchange = () => { openProject(ui.projectInput.files[0]); ui.projectInput.value = ""; };
$("saveProject").onclick = saveProject;
$("exportPdf").onclick = exportPdf; $("exportAll").onclick = exportAll;
$("splitToggle").onclick = () => setSplit(!app.split);
$("pdfListButton").onclick = () => togglePdfList(!app.listOpen);
$("pdfSort").onchange = (event) => {
  app.pdfSort = event.target.value;
  try { sessionStorage.setItem("editor-pdf-sort", app.pdfSort); } catch { /* Sin persistencia de orden. */ }
  renderPdfList();
};
$("closeCurrent").onclick = () => { const doc = currentDoc(); if (doc) closeDoc(doc.id); };
$("toolHand").onclick = () => setTool("hand");
$("toolHighlight").onclick = () => setTool("highlight");
$("toolInk").onclick = () => setTool("ink");
$("toolCallout").onclick = () => setTool("callout");
$("toolSelect").onclick = () => setTool("select");
$("toolErase").onclick = () => setTool("erase");
$("undo").onclick = undo; $("redo").onclick = redo;
$("addLayer").onclick = () => { const doc = currentDoc(); if (!doc) return;
  mutate(doc, () => { const layer = app.tool === "ink" ? newInkLayer(doc) : defaultLayer(doc.layers.length + 1);
    doc.layers.push(layer); doc.activeLayerId = layer.id; }); };
$("inkWidth").oninput = (event) => {
  const doc = currentDoc(); if (!doc) return;
  doc.inkWidth = Number(event.target.value); $("inkWidthLabel").textContent = String(doc.inkWidth); persist(doc);
};
$("inkColor").onchange = (event) => {
  const doc = currentDoc(); if (!doc) return;
  doc.inkColor = validInkColor(event.target.value);
  persist(doc);
  status(`Lápiz ${doc.inkColor} para las próximas notas de ${doc.name}`);
};
$("deleteMark").onclick = () => { const doc = currentDoc(); if (doc?.selectedMarkId) eraseMark(doc, doc.selectedMarkId); };
$("clearMarks").onclick = () => {
  const doc = currentDoc(); if (!doc?.marks.length) return;
  if (!confirm(`¿Borrar las ${doc.marks.length} marcas de “${doc.name}”? Puedes deshacer con Ctrl+Z.`)) return;
  mutate(doc, () => { doc.marks = []; doc.selectedMarkId = null; });
  status(`Se borraron las marcas de ${doc.name} · Ctrl+Z para deshacer`);
};
panes.forEach((pane, index) => {
  pane.root.addEventListener("pointerdown", () => activatePane(index));
  $("prev" + pane.suffix).onclick = () => changePage(index, -1);
  $("next" + pane.suffix).onclick = () => changePage(index, 1);
  $("zoomOut" + pane.suffix).onclick = () => { const doc = docFor(index); if (doc) setZoom(index, doc.zoom / 1.2); };
  $("zoomIn" + pane.suffix).onclick = () => { const doc = docFor(index); if (doc) setZoom(index, doc.zoom * 1.2); };
  $("fit" + pane.suffix).onclick = () => fitPane(index);
  pane.viewport.addEventListener("wheel", (event) => { const doc = docFor(index); if (!doc) return;
    event.preventDefault(); activatePane(index); setZoom(index, doc.zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
  }, { passive: false });
  pane.viewport.addEventListener("pointerdown", (event) => pointerDown(event, index));
  pane.viewport.addEventListener("pointermove", (event) => pointerMove(event, index));
  pane.viewport.addEventListener("pointerup", (event) => pointerUp(event, index));
  pane.viewport.addEventListener("scroll", () => scheduleDetail(index), { passive: true });
  pane.viewport.addEventListener("dblclick", (event) => {
    const doc = docFor(index);
    const id = event.target.closest?.("[data-mark-id]")?.dataset.markId;
    const mark = doc?.marks.find((item) => item.id === id);
    if (!mark || mark.kind !== "callout") return;
    activatePane(index);
    const value = prompt("Editar texto de revisión:", mark.text.replaceAll("\n", " "));
    if (!value?.trim()) return;
    mutate(doc, () => {
      mark.text = wrapText(value.trim().slice(0, 300)).join("\n");
      const height = doc.pages[mark.page].height;
      mark.boxH = Math.min(height - 8, Math.max(38, mark.text.split("\n").length * 14 + 14));
      mark.boxY = clamp(mark.boxY, 0, height - mark.boxH);
    });
    status("Texto de revisión actualizado");
  });
  pane.viewport.addEventListener("pointercancel", (event) => {
    if (event.pointerType === "touch") {
      pane.touchPoints.delete(event.pointerId);
      if (pane.touchPoints.size < 2) pane.pinch = null;
      pane.ignoreTouchUntilClear = pane.touchPoints.size > 0;
    }
    if (pane.interaction?.pointerId === event.pointerId) pane.interaction = null;
    pane.viewport.classList.remove("dragging");
    renderMarks(index);
    if (pane.viewport.hasPointerCapture(event.pointerId)) pane.viewport.releasePointerCapture(event.pointerId);
  });
});
window.addEventListener("resize", () => panes.forEach((_, index) => scheduleDetail(index)));
document.addEventListener("pointerdown", (event) => {
  if (app.listOpen && !$("pdfListMenu").contains(event.target) && !$("pdfListButton").contains(event.target))
    togglePdfList(false);
});
document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.altKey && key === "w") {
    const doc = currentDoc();
    if (doc) { event.preventDefault(); event.stopPropagation(); closeDoc(doc.id); }
    return;
  }
  if (event.key === "Escape" && app.listOpen) { togglePdfList(false); return; }
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.ctrlKey && !event.altKey && key === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (event.ctrlKey && !event.altKey && key === "y") { event.preventDefault(); redo(); return; }
  if (event.key === " " && !event.repeat) { event.preventDefault(); app.temporaryHand = true; renderAll(); }
  if (key === "h") setTool("hand"); if (key === "r") setTool("highlight");
  if (key === "d") setTool("ink");
  if (key === "t") setTool("callout"); if (key === "v") setTool("select");
  if (key === "e") setTool("erase");
  if (event.key === "Delete" && currentDoc()?.selectedMarkId) $("deleteMark").click();
}, true);
document.addEventListener("keyup", (event) => { if (event.key === " ") { app.temporaryHand = false; renderAll(); } });
try { app.pdfSort = sessionStorage.getItem("editor-pdf-sort") || "name"; } catch { /* Orden alfabético por defecto. */ }
renderAll(); restoreSession();
