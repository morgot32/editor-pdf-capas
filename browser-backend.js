"use strict";

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFOperator,
  StandardFonts, LineCapStyle, rgb, degrees } from "pdf-lib";
import JSZip from "jszip";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MAX_DOCUMENTS = 20;
const records = new Map();
let savedLoaded = false;
let databasePromise;

function database() {
  if (!databasePromise) databasePromise = new Promise((resolve) => {
    if (!window.indexedDB) { resolve(null); return; }
    const request = indexedDB.open("editor-pdf-capas-ipad", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("documents"))
        request.result.createObjectStore("documents", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return databasePromise;
}
async function stored(operation, value) {
  const db = await database();
  if (!db) return operation === "getAll" ? [] : null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("documents", operation === "getAll" ? "readonly" : "readwrite");
    const request = operation === "getAll" ? tx.objectStore("documents").getAll()
      : operation === "put" ? tx.objectStore("documents").put(value)
        : tx.objectStore("documents").delete(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function loadSaved() {
  if (savedLoaded) return;
  const rows = await stored("getAll");
  for (const row of rows) if (!records.has(row.id))
    records.set(row.id, { info: row.info, blob: row.blob, pdf: null });
  savedLoaded = true;
}
async function loadProxy(record, initialBuffer) {
  if (record.pdf) return record.pdf;
  const buffer = initialBuffer || await record.blob.arrayBuffer();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false,
    useSystemFonts: true });
  record.pdf = await task.promise;
  return record.pdf;
}

export async function listDocuments() {
  await loadSaved();
  return Array.from(records.values(), (item) => item.info)
    .sort((a, b) => a.openedAt - b.openedAt);
}

export async function openDocument(file, buffer, hash, onProgress = () => {}) {
  await loadSaved();
  if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("Selecciona un archivo PDF.");
  if (file.size > MAX_FILE_BYTES) throw new Error("En iPad el límite por PDF es de 80 MB.");
  if (records.size >= MAX_DOCUMENTS) throw new Error("Cierra un PDF antes de abrir más de 20.");
  const record = { blob: file, pdf: null };
  const pdf = await loadProxy(record, buffer);
  if (!pdf.numPages) throw new Error("El PDF no contiene hojas.");
  const pages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ width: Math.round(viewport.width * 1000) / 1000,
      height: Math.round(viewport.height * 1000) / 1000 });
    onProgress(pageNo, pdf.numPages);
    page.cleanup();
  }
  const info = { id: crypto.randomUUID(), name: file.name.slice(0, 180), pages,
    sha256: hash, openedAt: Date.now(), modifiedAt: file.lastModified || 0 };
  record.info = info;
  try { await stored("put", { id: info.id, info, blob: file }); }
  catch (error) { console.warn("El PDF sólo estará disponible hasta cerrar esta pestaña:", error); }
  records.set(info.id, record);
  return info;
}

export async function closeDocument(id) {
  const record = records.get(id);
  records.delete(id);
  if (record?.pdf) await record.pdf.destroy();
  try { await stored("delete", id); } catch (error) { console.warn("No se pudo borrar la copia local:", error); }
}

export async function renderPage(id, pageIndex, region = null) {
  await loadSaved();
  const record = records.get(id);
  if (!record) throw new Error("PDF no encontrado en este dispositivo.");
  const pdf = await loadProxy(record);
  const page = await pdf.getPage(pageIndex + 1);
  const basic = page.getViewport({ scale: 1 });
  const scale = region?.scale || Math.min(2, 4096 / Math.max(basic.width, basic.height));
  const x = region?.x || 0, y = region?.y || 0;
  const width = region?.width || basic.width, height = region?.height || basic.height;
  if (region && (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(width) || !Number.isFinite(height) || scale <= 0 || width <= 0 || height <= 0 ||
      x < 0 || y < 0 || x + width > basic.width + 0.01 || y + height > basic.height + 0.01 ||
      width * scale > 4096 || height * scale > 4096 || width * height * scale * scale > 12_000_000))
    throw new Error("La zona HD solicitada es demasiado grande.");
  const viewport = page.getViewport({ scale, offsetX: -x * scale, offsetY: -y * scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("El navegador no pudo crear el lienzo HD.");
  await page.render({ canvasContext: context, viewport }).promise;
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("No se pudo dibujar la página.")), "image/png"));
  canvas.width = canvas.height = 0;
  return blob;
}

function color(hex) {
  return rgb(parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
}
function ocgProperties(pdfDoc, layers) {
  const context = pdfDoc.context;
  const catalog = pdfDoc.catalog;
  let properties = catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
  if (!properties) { properties = context.obj({}); catalog.set(PDFName.of("OCProperties"), properties); }
  let groups = properties.lookupMaybe(PDFName.of("OCGs"), PDFArray);
  if (!groups) { groups = context.obj([]); properties.set(PDFName.of("OCGs"), groups); }
  let defaults = properties.lookupMaybe(PDFName.of("D"), PDFDict);
  if (!defaults) { defaults = context.obj({}); properties.set(PDFName.of("D"), defaults); }
  let order = defaults.lookupMaybe(PDFName.of("Order"), PDFArray);
  if (!order) { order = context.obj([]); defaults.set(PDFName.of("Order"), order); }
  let visible = defaults.lookupMaybe(PDFName.of("ON"), PDFArray);
  if (!visible) { visible = context.obj([]); defaults.set(PDFName.of("ON"), visible); }
  let hidden = defaults.lookupMaybe(PDFName.of("OFF"), PDFArray);
  if (!hidden) { hidden = context.obj([]); defaults.set(PDFName.of("OFF"), hidden); }
  const references = new Map();
  for (const layer of layers) {
    const ref = context.register(context.obj({ Type: PDFName.of("OCG"),
      Name: PDFHexString.fromText(layer.name.slice(0, 80)) }));
    groups.push(ref); order.push(ref); (layer.visible ? visible : hidden).push(ref);
    references.set(layer.id, ref);
  }
  return references;
}
function attachLayerResources(pdfDoc, page, layers, references) {
  const context = pdfDoc.context;
  const resources = page.node.normalizedEntries().Resources;
  let properties = resources.lookupMaybe(PDFName.of("Properties"), PDFDict);
  if (!properties) { properties = context.obj({}); resources.set(PDFName.of("Properties"), properties); }
  const names = new Map();
  layers.forEach((layer, index) => {
    const name = PDFName.of("EditorLayer" + index);
    properties.set(name, references.get(layer.id));
    names.set(layer.id, name);
  });
  return names;
}
function pdfBounds(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
function safeText(value, font) {
  const text = String(value || "");
  try { font.encodeText(text); return text; }
  catch { return Array.from(text, (char) => { try { font.encodeText(char); return char; } catch { return "?"; } }).join(""); }
}
function drawMark(page, mark, layer, toPdf, font, textAngle) {
  const tint = color(layer.color);
  const opacity = Math.max(0.05, Math.min(1, Number(layer.opacity) || 1));
  if (mark.kind === "highlight") {
    const box = pdfBounds(toPdf(mark.x0, mark.y0), toPdf(mark.x1, mark.y1));
    page.drawRectangle({ ...box, color: tint, opacity });
  } else if (mark.kind === "ink") {
    const points = mark.points.map(([x, y]) => toPdf(x, y));
    const width = Math.max(0.5, Number(mark.width) || 2.5);
    if (points.length === 1)
      page.drawCircle({ x: points[0].x, y: points[0].y, size: width / 2, color: tint, opacity });
    else for (let index = 1; index < points.length; index++)
      page.drawLine({ start: points[index - 1], end: points[index], thickness: width,
        color: tint, opacity, lineCap: LineCapStyle.Round });
  } else if (mark.kind === "callout") {
    const tip = toPdf(mark.tipX, mark.tipY);
    const anchor = toPdf(mark.boxX + mark.boxW / 2, mark.boxY + mark.boxH / 2);
    const red = rgb(0.72, 0.21, 0.16);
    page.drawLine({ start: anchor, end: tip, thickness: 1.6, color: red });
    const dx = tip.x - anchor.x, dy = tip.y - anchor.y, length = Math.max(1, Math.hypot(dx, dy));
    const wing = { x: tip.x - dx / length * 9, y: tip.y - dy / length * 9 };
    const left = { x: wing.x - dy / length * 4, y: wing.y + dx / length * 4 };
    const right = { x: wing.x + dy / length * 4, y: wing.y - dx / length * 4 };
    page.drawLine({ start: tip, end: left, thickness: 1.6, color: red });
    page.drawLine({ start: tip, end: right, thickness: 1.6, color: red });
    const box = pdfBounds(toPdf(mark.boxX, mark.boxY),
      toPdf(mark.boxX + mark.boxW, mark.boxY + mark.boxH));
    page.drawRectangle({ ...box, color: rgb(1, 1, 0.98), opacity: 0.96,
      borderColor: red, borderWidth: 1 });
    String(mark.text || "").split("\n").forEach((line, index) => {
      const position = toPdf(mark.boxX + 8, mark.boxY + 15 + index * 14);
      page.drawText(safeText(line, font), { x: position.x, y: position.y,
        size: 10, font, color: rgb(0.12, 0.18, 0.25), rotate: degrees(textAngle) });
    });
  }
}

export async function exportDocument(project) {
  await loadSaved();
  const record = records.get(project.id);
  if (!record) throw new Error("PDF no encontrado en este dispositivo.");
  const document = await PDFDocument.load(await record.blob.arrayBuffer());
  const source = await loadProxy(record);
  const layers = project.layers || [];
  const layerMap = new Map(layers.map((layer) => [layer.id, layer]));
  const references = ocgProperties(document, layers);
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < document.getPageCount(); index++) {
    const marks = (project.marks || []).filter((mark) => mark.page === index && layerMap.has(mark.layerId));
    if (!marks.length) continue;
    const page = document.getPage(index);
    const sourcePage = await source.getPage(index + 1);
    const viewport = sourcePage.getViewport({ scale: 1 });
    const toPdf = (x, y) => {
      const [px, py] = pdfjs.Util.applyInverseTransform([x, y], viewport.transform);
      return { x: px, y: py };
    };
    const [vx, vy] = pdfjs.Util.applyInverseTransform([1, 0], viewport.transform);
    const [ox, oy] = pdfjs.Util.applyInverseTransform([0, 0], viewport.transform);
    const textAngle = Math.atan2(vy - oy, vx - ox) * 180 / Math.PI;
    const layerNames = attachLayerResources(document, page, layers, references);
    for (const mark of marks) {
      const layer = layerMap.get(mark.layerId);
      page.pushOperators(PDFOperator.of("BDC", [PDFName.of("OC"), layerNames.get(layer.id)]));
      drawMark(page, mark, layer, toPdf, font, textAngle);
      page.pushOperators(PDFOperator.of("EMC"));
    }
  }
  return new Blob([await document.save()], { type: "application/pdf" });
}

export async function exportAll(projects) {
  const archive = new JSZip();
  for (let index = 0; index < projects.length; index++) {
    const project = projects[index];
    const record = records.get(project.id);
    if (!record) throw new Error("Uno de los PDF ya no está abierto.");
    const name = record.info.name.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N}_ -]/gu, "").slice(0, 80) || "documento";
    const pdfBlob = await exportDocument(project);
    archive.file(`${String(index + 1).padStart(2, "0")}_${name}_marcado.pdf`,
      new Uint8Array(await pdfBlob.arrayBuffer()));
  }
  return archive.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } });
}
