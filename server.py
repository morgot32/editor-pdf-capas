"""Servidor local para visualizar y exportar PDF con capas de resaltado."""

from __future__ import annotations

import io
import errno
import hashlib
import math
import json
import mimetypes
from pathlib import Path
import secrets
import threading
import webbrowser
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import fitz


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8787
MAX_PORT = 8797
MAX_PDF_BYTES = 120 * 1024 * 1024
MAX_TOTAL_PDF_BYTES = 600 * 1024 * 1024
MAX_JSON_BYTES = 20 * 1024 * 1024
MAX_DOCUMENTS = 20


class PdfState:
    def __init__(self):
        self.lock = threading.RLock()
        self.documents = {}


STATE = PdfState()


def page_sizes(document):
    return [
        {"width": round(page.rect.width, 3), "height": round(page.rect.height, 3)}
        for page in document
    ]


def validate_project(project, sizes):
    if not isinstance(project, dict):
        raise ValueError("El proyecto no es válido.")
    layers = project.get("layers")
    marks = project.get("marks")
    if not isinstance(layers, list) or not isinstance(marks, list):
        raise ValueError("Faltan capas o marcas.")
    if len(layers) > 100 or len(marks) > 100000:
        raise ValueError("El proyecto supera el límite permitido.")
    ids = set()
    clean_layers = []
    for layer in layers:
        if not isinstance(layer, dict):
            raise ValueError("Hay una capa inválida.")
        layer_id = str(layer.get("id", ""))
        name = str(layer.get("name", ""))[:80].strip()
        color = str(layer.get("color", ""))
        opacity = layer.get("opacity", 0.35)
        if not layer_id or layer_id in ids or not name:
            raise ValueError("Hay identificadores o nombres de capa inválidos.")
        if len(color) != 7 or color[0] != "#" or any(c not in "0123456789abcdefABCDEF" for c in color[1:]):
            raise ValueError("El color de una capa no es válido.")
        if not isinstance(opacity, (int, float)) or not 0.05 <= opacity <= 1:
            raise ValueError("La opacidad de una capa no es válida.")
        ids.add(layer_id)
        role = layer.get("role", "highlight")
        if role not in ("highlight", "ink"):
            raise ValueError("Hay un tipo de capa inválido.")
        clean_layers.append({"id": layer_id, "name": name, "color": color,
                             "opacity": float(opacity), "visible": bool(layer.get("visible", True)), "role": role})
    clean_marks = []
    for mark in marks:
        if not isinstance(mark, dict):
            raise ValueError("Hay una marca inválida.")
        layer_id = str(mark.get("layerId", ""))
        page_no = mark.get("page")
        if layer_id not in ids or not isinstance(page_no, int) or not 0 <= page_no < len(sizes):
            raise ValueError("Una marca usa una capa o página inexistente.")
        width, height = sizes[page_no]["width"], sizes[page_no]["height"]
        kind = mark.get("kind", "highlight")
        if kind == "highlight":
            try:
                x0, y0, x1, y1 = (float(mark[key]) for key in ("x0", "y0", "x1", "y1"))
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError("Hay coordenadas de marca inválidas.") from exc
            if not (0 <= x0 < x1 <= width + 0.01 and 0 <= y0 < y1 <= height + 0.01):
                raise ValueError("Una marca está fuera de la página.")
            clean_marks.append((page_no, layer_id, kind, fitz.Rect(x0, y0, x1, y1)))
        elif kind == "callout":
            try:
                tip_x, tip_y, box_x, box_y, box_w, box_h = (
                    float(mark[key]) for key in ("tipX", "tipY", "boxX", "boxY", "boxW", "boxH"))
                text = str(mark["text"]).strip()
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError("Hay un texto de revisión inválido.") from exc
            if not text or len(text) > 500 or not (0 <= tip_x <= width and 0 <= tip_y <= height and
                    0 <= box_x < box_x + box_w <= width + 0.01 and
                    0 <= box_y < box_y + box_h <= height + 0.01 and box_w >= 60 and box_h >= 25):
                raise ValueError("Hay un texto de revisión fuera de la página.")
            clean_marks.append((page_no, layer_id, kind, (tip_x, tip_y, box_x, box_y, box_w, box_h, text)))
        elif kind == "ink":
            points = mark.get("points")
            pen_width = mark.get("width", 2.5)
            if (not isinstance(points, list) or not 1 <= len(points) <= 10000 or
                    not isinstance(pen_width, (int, float)) or not 0.5 <= pen_width <= 20):
                raise ValueError("Hay un trazo inválido.")
            clean_points = []
            for point in points:
                if (not isinstance(point, (list, tuple)) or len(point) != 2 or
                        not all(isinstance(value, (int, float)) and math.isfinite(value) for value in point)):
                    raise ValueError("Hay puntos de dibujo inválidos.")
                x, y = float(point[0]), float(point[1])
                if not (0 <= x <= width + 0.01 and 0 <= y <= height + 0.01):
                    raise ValueError("Un trazo está fuera de la página.")
                clean_points.append((x, y))
            clean_marks.append((page_no, layer_id, kind, (clean_points, float(pen_width))))
        else:
            raise ValueError("Tipo de marca desconocido.")
    return clean_layers, clean_marks


def add_ink_dot(page, point, pen_width, rgb, opacity, ocg):
    x, y = point
    radius = pen_width / 2
    view_dot = fitz.Rect(max(0, x - radius), max(0, y - radius),
                         min(page.rect.width, x + radius), min(page.rect.height, y + radius))
    dot = page.add_circle_annot(view_dot * page.derotation_matrix)
    dot.set_colors(stroke=rgb, fill=rgb)
    dot.set_border(width=0)
    dot.set_opacity(opacity)
    dot.set_oc(ocg)
    dot.update()


def export_pdf(data, project, sizes):
    layers, marks = validate_project(project, sizes)
    document = fitz.open(stream=data, filetype="pdf")
    try:
        ocgs = {layer["id"]: document.add_ocg(layer["name"], on=int(layer["visible"]))
                for layer in layers}
        layer_map = {layer["id"]: layer for layer in layers}
        for page_no, layer_id, kind, geometry in marks:
            page = document[page_no]
            layer = layer_map[layer_id]
            if kind == "highlight":
                # La vista usa coordenadas rotadas; la anotación PDF usa las originales.
                pdf_rect = geometry * page.derotation_matrix
                annot = page.add_rect_annot(pdf_rect)
                color = layer["color"]
                rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
                annot.set_colors(stroke=rgb, fill=rgb)
                annot.set_border(width=0)
                annot.set_opacity(layer["opacity"])
                annot.set_oc(ocgs[layer_id])
                annot.update()
            elif kind == "ink":
                points, pen_width = geometry
                color = layer["color"]
                rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
                if len(points) == 1:
                    add_ink_dot(page, points[0], pen_width, rgb, layer["opacity"], ocgs[layer_id])
                else:
                    pdf_points = []
                    for x, y in points:
                        point = fitz.Point(x, y) * page.derotation_matrix
                        pdf_points.append((point.x, point.y))
                    annot = page.add_ink_annot([pdf_points])
                    annot.set_colors(stroke=rgb)
                    annot.set_border(width=pen_width)
                    annot.set_opacity(layer["opacity"])
                    annot.set_oc(ocgs[layer_id])
                    annot.update()
                    add_ink_dot(page, points[0], pen_width, rgb, layer["opacity"], ocgs[layer_id])
                    add_ink_dot(page, points[-1], pen_width, rgb, layer["opacity"], ocgs[layer_id])
            else:
                tip_x, tip_y, box_x, box_y, box_w, box_h, text = geometry
                box = fitz.Rect(box_x, box_y, box_x + box_w, box_y + box_h)
                anchor = fitz.Point(box_x + box_w / 2, box_y + box_h / 2)
                tip = fitz.Point(tip_x, tip_y)
                arrow = page.add_line_annot(anchor * page.derotation_matrix, tip * page.derotation_matrix)
                arrow.set_colors(stroke=(0.72, 0.21, 0.16))
                arrow.set_border(width=1.5)
                arrow.set_line_ends(fitz.PDF_ANNOT_LE_NONE, fitz.PDF_ANNOT_LE_CLOSED_ARROW)
                arrow.set_oc(ocgs[layer_id])
                arrow.update()
                frame = page.add_rect_annot(box * page.derotation_matrix)
                frame.set_colors(stroke=(0.72, 0.21, 0.16), fill=(1, 1, 1))
                frame.set_border(width=1)
                frame.set_opacity(1)
                frame.set_oc(ocgs[layer_id])
                frame.update()
                text_box = fitz.Rect(box_x + 8, box_y + 5, box_x + box_w - 7, box_y + box_h - 5)
                note = page.add_freetext_annot(text_box * page.derotation_matrix, text,
                                              fontsize=10, text_color=(0.12, 0.18, 0.25),
                                              rotate=page.rotation)
                note.set_oc(ocgs[layer_id])
                note.update()
        output = io.BytesIO()
        document.save(output, garbage=3, deflate=True)
        return output.getvalue()
    finally:
        document.close()


def choose_save_path(filename, extension):
    """Muestra Guardar como en el equipo donde se ejecuta el servidor."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    try:
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()
        filetypes = [("Documento PDF", "*.pdf")] if extension == ".pdf" else [("Archivo ZIP", "*.zip")]
        return filedialog.asksaveasfilename(parent=root, title="Guardar exportación como",
                                            initialfile=filename, defaultextension=extension,
                                            filetypes=filetypes)
    finally:
        root.destroy()


def save_with_dialog(data, filename, extension):
    path = choose_save_path(filename, extension)
    if not path:
        return {"saved": False}
    destination = Path(path)
    destination.write_bytes(data)
    return {"saved": True, "path": str(destination)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string, *args):
        print("%s - %s" % (self.address_string(), format_string % args))

    def send_bytes(self, status, body, content_type, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition", "attachment; filename=\"%s\"" % filename)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, data):
        self.send_bytes(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def read_body(self, limit):
        size = int(self.headers.get("Content-Length", "0"))
        if size <= 0 or size > limit:
            raise ValueError("Archivo vacío o demasiado grande.")
        return self.rfile.read(size)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/capabilities":
            self.send_json(200, {"multiDocument": True, "version": 2})
            return
        if path == "/api/documents":
            with STATE.lock:
                self.send_json(200, {"documents": [
                    {"id": doc_id, "name": item["name"], "pages": item["pages"], "sha256": item["sha256"],
                     "openedAt": item["openedAt"], "modifiedAt": item["modifiedAt"]}
                    for doc_id, item in STATE.documents.items()]})
            return
        if path == "/api/page":
            with STATE.lock:
                query = parse_qs(parsed.query)
                item = STATE.documents.get(query.get("id", [""])[0])
            if not item:
                self.send_json(404, {"error": "PDF no encontrado."})
                return
            try:
                page_no = int(query.get("page", ["0"])[0])
                if not 0 <= page_no < len(item["pages"]):
                    raise ValueError("Página inexistente.")
                document = fitz.open(stream=item["data"], filetype="pdf")
                try:
                    page = document[page_no]
                    detail_fields = ("x", "y", "width", "height", "scale")
                    if any(field in query for field in detail_fields):
                        if not all(field in query for field in detail_fields):
                            raise ValueError("Faltan datos de la zona HD.")
                        x, y, width, height, scale = (float(query[field][0]) for field in detail_fields)
                        if not all(math.isfinite(value) for value in (x, y, width, height, scale)) or (
                                x < 0 or y < 0 or width <= 0 or height <= 0 or scale <= 0 or
                                x + width > page.rect.width + 0.01 or
                                y + height > page.rect.height + 0.01 or
                                width * scale > 4096 or height * scale > 4096 or
                                width * height * scale * scale > 12_000_000):
                            raise ValueError("La zona HD solicitada es demasiado grande.")
                        clip = fitz.Rect(x, y, x + width, y + height)
                    else:
                        scale = min(2, 5000 / max(page.rect.width, page.rect.height))
                        clip = None
                    image = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip,
                                            alpha=False, annots=True).tobytes("png")
                finally:
                    document.close()
                self.send_bytes(200, image, "image/png")
            except (ValueError, fitz.FileDataError) as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if path == "/":
            path = "/index.html"
        if path not in ("/index.html", "/app.js", "/styles.css"):
            self.send_json(404, {"error": "No encontrado."})
            return
        filename = ROOT / path.lstrip("/")
        content_type = mimetypes.guess_type(filename.name)[0] or "application/octet-stream"
        self.send_bytes(200, filename.read_bytes(), content_type + ("; charset=utf-8" if content_type.startswith("text/") or content_type == "application/javascript" else ""))

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/open":
                data = self.read_body(MAX_PDF_BYTES)
                document = fitz.open(stream=data, filetype="pdf")
                try:
                    if document.needs_pass:
                        raise ValueError("Este PDF requiere contraseña.")
                    sizes = page_sizes(document)
                finally:
                    document.close()
                name = unquote(self.headers.get("X-File-Name", "documento.pdf"))
                name = Path(name).name[:180] or "documento.pdf"
                try:
                    modified_at = max(0, int(self.headers.get("X-File-Modified", "0")))
                except ValueError:
                    modified_at = 0
                opened_at = int(datetime.now(timezone.utc).timestamp() * 1000)
                with STATE.lock:
                    if len(STATE.documents) >= MAX_DOCUMENTS:
                        raise ValueError("Cierre un PDF antes de abrir más de 20 documentos.")
                    if sum(len(item["data"]) for item in STATE.documents.values()) + len(data) > MAX_TOTAL_PDF_BYTES:
                        raise ValueError("Los PDF abiertos superan 600 MB. Cierre algunos antes de continuar.")
                    doc_id = secrets.token_urlsafe(12)
                    digest = hashlib.sha256(data).hexdigest()
                    STATE.documents[doc_id] = {"data": data, "name": name, "pages": sizes,
                                               "sha256": digest, "openedAt": opened_at, "modifiedAt": modified_at}
                self.send_json(200, {"id": doc_id, "name": name, "pages": sizes, "sha256": digest,
                                     "openedAt": opened_at, "modifiedAt": modified_at})
                return
            if path in ("/api/export", "/api/export-save"):
                project = json.loads(self.read_body(MAX_JSON_BYTES))
                if not isinstance(project, dict):
                    raise ValueError("Proyecto inválido.")
                with STATE.lock:
                    item = STATE.documents.get(project.get("id"))
                    if not item:
                        self.send_json(404, {"error": "PDF no encontrado."})
                        return
                result = export_pdf(item["data"], project, item["pages"])
                stem = Path(item["name"]).stem
                safe_stem = "".join(c for c in stem if c.isalnum() or c in "-_ ")[:100].strip() or "documento"
                filename = safe_stem + "_marcado.pdf"
                if path == "/api/export-save":
                    self.send_json(200, save_with_dialog(result, filename, ".pdf"))
                else:
                    self.send_bytes(200, result, "application/pdf", filename)
                return
            if path in ("/api/export-all", "/api/export-all-save"):
                projects = json.loads(self.read_body(MAX_JSON_BYTES))
                if not isinstance(projects, list) or not projects:
                    raise ValueError("No hay documentos para exportar.")
                if not all(isinstance(project, dict) for project in projects):
                    raise ValueError("Hay un proyecto inválido.")
                with STATE.lock:
                    items = [(project, STATE.documents.get(project.get("id"))) for project in projects]
                if any(item is None for _, item in items):
                    raise ValueError("Uno de los PDF ya no está abierto.")
                output = io.BytesIO()
                with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    for index, (project, item) in enumerate(items, 1):
                        result = export_pdf(item["data"], project, item["pages"])
                        stem = "".join(c for c in Path(item["name"]).stem if c.isalnum() or c in "-_ ")[:80].strip() or "documento"
                        archive.writestr(f"{index:02d}_{stem}_marcado.pdf", result)
                if path == "/api/export-all-save":
                    self.send_json(200, save_with_dialog(output.getvalue(), "PDFs_marcados.zip", ".zip"))
                else:
                    self.send_bytes(200, output.getvalue(), "application/zip", "PDFs_marcados.zip")
                return
            self.send_json(404, {"error": "No encontrado."})
        except (ValueError, json.JSONDecodeError, fitz.FileDataError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            print("Error:", repr(exc))
            self.send_json(500, {"error": "No se pudo procesar el PDF."})

    def do_DELETE(self):
        if urlparse(self.path).path != "/api/document":
            self.send_json(404, {"error": "No encontrado."})
            return
        doc_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
        with STATE.lock:
            item = STATE.documents.pop(doc_id, None)
        self.send_json(200 if item else 404, {"closed": bool(item)})


def main():
    for port in range(PORT, MAX_PORT + 1):
        try:
            server = ThreadingHTTPServer((HOST, port), Handler)
            break
        except OSError as exc:
            if exc.errno not in (errno.EADDRINUSE, 10048) or port == MAX_PORT:
                raise
    url = "http://%s:%d/" % (HOST, server.server_port)
    print("Editor PDF con capas: " + url)
    if server.server_port != PORT:
        print("El puerto 8787 ya está ocupado. Esta sesión nueva usa el puerto %d." % server.server_port)
    print("Mantenga esta ventana abierta. Ctrl+C para cerrar.")
    threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
