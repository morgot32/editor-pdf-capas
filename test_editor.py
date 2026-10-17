"""Prueba local de varios PDF, resaltados, flechas y exportación por capas."""

import importlib.util
import io
import json
import struct
import tempfile
import threading
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

import fitz


spec = importlib.util.spec_from_file_location("editor_pdf", Path(__file__).with_name("server.py"))
editor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editor)


def request_json(url, method="GET", data=None, headers=None):
    body = None if data is None else json.dumps(data).encode("utf-8")
    request = urllib.request.Request(url, body, headers or {}, method=method)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), editor.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = "http://127.0.0.1:%d" % server.server_port
    try:
        opened = []
        for index in (1, 2):
            source = fitz.open()
            page = source.new_page(width=400, height=300)
            page.insert_text((40, 45), "PDF %d" % index)
            if index == 1:
                for number in range(2, 5):
                    extra = source.new_page(width=400, height=300)
                    extra.insert_text((40, 45), "HOJA %d" % number)
            if index == 2:
                page.set_rotation(90)
            request = urllib.request.Request(
                base + "/api/open", source.tobytes(),
                {"Content-Type": "application/pdf", "X-File-Name": "revision%d.pdf" % index,
                 "X-File-Modified": str(index * 1000)}, method="POST")
            opened.append(json.load(urllib.request.urlopen(request, timeout=10)))
        first, second = opened
        assert first["id"] != second["id"]
        assert len(request_json(base + "/api/documents")["documents"]) == 2
        assert first["modifiedAt"] == 1000 and second["modifiedAt"] == 2000
        assert first["openedAt"] > 0
        assert first["pages"] == [{"width": 400.0, "height": 300.0}] * 4
        assert second["pages"] == [{"width": 300.0, "height": 400.0}]
        for info in opened:
            image = urllib.request.urlopen(base + "/api/page?id=" + info["id"] + "&page=0", timeout=10).read()
            assert image.startswith(b"\x89PNG\r\n\x1a\n")
            detail = urllib.request.urlopen(
                base + "/api/page?id=" + info["id"] +
                "&page=0&x=10&y=10&width=50&height=40&scale=6", timeout=10).read()
            assert struct.unpack(">II", detail[16:24]) == (300, 240)
        last_page = urllib.request.urlopen(base + "/api/page?id=" + first["id"] + "&page=3", timeout=10).read()
        assert last_page.startswith(b"\x89PNG\r\n\x1a\n")

        layer = {"id": "a", "name": "Revisión", "color": "#ffe45c", "opacity": 0.5, "visible": True}
        ink_layer = {"id": "ink", "name": "Dibujo", "color": "#d44332", "opacity": 1,
                     "visible": True, "role": "ink"}
        projects = [
            {"id": first["id"], "layers": [layer, ink_layer], "marks": [
                {"kind": "highlight", "page": 0, "layerId": "a", "x0": 20, "y0": 20, "x1": 150, "y1": 50},
                {"kind": "callout", "page": 0, "layerId": "a", "tipX": 50, "tipY": 100,
                 "boxX": 160, "boxY": 120, "boxW": 190, "boxH": 55, "text": "Revisar este punto"},
                {"kind": "ink", "page": 0, "layerId": "ink", "points": [[180, 230], [240, 230], [300, 230]], "width": 3},
                {"kind": "ink", "page": 0, "layerId": "ink", "points": [[320, 230]], "width": 4},
                {"kind": "highlight", "page": 3, "layerId": "a", "x0": 20, "y0": 20, "x1": 150, "y1": 50},
            ]},
            {"id": second["id"], "layers": [layer], "marks": [
                {"kind": "highlight", "page": 0, "layerId": "a", "x0": 20, "y0": 20, "x1": 150, "y1": 50},
            ]},
        ]
        request = urllib.request.Request(base + "/api/export", json.dumps(projects[0]).encode(),
                                         {"Content-Type": "application/json"}, method="POST")
        current_pdf = fitz.open(stream=urllib.request.urlopen(request, timeout=15).read(), filetype="pdf")
        assert current_pdf.page_count == 4
        current_page = current_pdf[0]
        assert len(list(current_page.annots())) == 8
        assert list(current_pdf[1].annots()) == []
        assert "HOJA 4" in current_pdf[3].get_text()
        assert len(list(current_pdf[3].annots())) == 1
        with tempfile.TemporaryDirectory() as temporary:
            editor.choose_save_path = lambda filename, extension: str(Path(temporary) / filename)
            saved_pdf = request_json(base + "/api/export-save", method="POST", data=projects[0],
                                     headers={"Content-Type": "application/json"})
            assert saved_pdf["saved"] and Path(saved_pdf["path"]).exists()
            saved_document = fitz.open(saved_pdf["path"])
            saved_page = saved_document[0]
            assert len(list(saved_page.annots())) == 8
            saved_document.close()
            saved_zip = request_json(base + "/api/export-all-save", method="POST", data=projects,
                                     headers={"Content-Type": "application/json"})
            assert saved_zip["saved"] and zipfile.is_zipfile(saved_zip["path"])
            editor.choose_save_path = lambda filename, extension: ""
            canceled = request_json(base + "/api/export-save", method="POST", data=projects[0],
                                    headers={"Content-Type": "application/json"})
            assert canceled == {"saved": False}
        request = urllib.request.Request(base + "/api/export-all", json.dumps(projects).encode(),
                                         {"Content-Type": "application/json"}, method="POST")
        archive_data = urllib.request.urlopen(request, timeout=15).read()
        with zipfile.ZipFile(io.BytesIO(archive_data)) as archive:
            names = archive.namelist()
            assert len(names) == 2 and all(name.endswith("_marcado.pdf") for name in names)
            first_pdf = fitz.open(stream=archive.read(names[0]), filetype="pdf")
            second_pdf = fitz.open(stream=archive.read(names[1]), filetype="pdf")
            assert first_pdf.page_count == 4 and second_pdf.page_count == 1
            assert len(first_pdf.get_ocgs()) == 2 and len(second_pdf.get_ocgs()) == 1
            first_page = first_pdf[0]
            second_page = second_pdf[0]
            first_annotations = list(first_page.annots())
            assert [item.type[1] for item in first_annotations] == ["Square", "Line", "Square", "FreeText",
                                                                   "Ink", "Circle", "Circle", "Circle"]
            assert all(item.get_oc() in first_pdf.get_ocgs() for item in first_annotations)
            assert first_page.get_pixmap().pixel(40, 35) != (255, 255, 255)
            assert first_page.get_pixmap().pixel(240, 230) != (255, 255, 255)
            rotated = list(second_page.annots())[0]
            assert rotated.rect * second_page.rotation_matrix == fitz.Rect(19, 19, 151, 51)
        request_json(base + "/api/document?id=" + first["id"], method="DELETE")
        assert len(request_json(base + "/api/documents")["documents"]) == 1
        print("OK: PDF de cuatro hojas, marcas por hoja, dibujo vectorial, capas, Guardar como y ZIP")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
