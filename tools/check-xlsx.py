#!/usr/bin/env python3
"""Validate the workbook produced by the extension's dependency-free XLSX writer.

Uses only the standard library: zipfile verifies every entry's CRC-32, and the
sheet XML is parsed to confirm the header row and data rows survived the trip.

Run after tests/verify.mjs (which writes tests/out/sample.xlsx):
    python3 tools/check-xlsx.py
"""
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REQUIRED_PARTS = {
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/worksheets/sheet1.xml",
}
EXPECTED_HEADERS = [
    "query", "page", "position", "listingId", "title", "price", "currency",
    "shopName", "image", "url", "rating", "reviewCount", "freeShipping",
    "bestseller", "sponsored", "scrapedAt",
]

path = Path(sys.argv[1] if len(sys.argv) > 1
            else Path(__file__).resolve().parent.parent / "tests/out/sample.xlsx")

if not path.exists():
    sys.exit(f"missing {path} — run `node tests/verify.mjs` first")

failures = []


def check(label, condition, detail=""):
    print(f"  {'✓' if condition else '✗'} {label}{'' if condition else f' — {detail}'}")
    if not condition:
        failures.append(label)


print(f"\nValidating {path.name} ({path.stat().st_size} bytes)")

with zipfile.ZipFile(path) as zf:
    check("ZIP structure is intact (all CRCs valid)", zf.testzip() is None, "corrupt entry")
    names = set(zf.namelist())
    check("contains the mandatory OPC parts", REQUIRED_PARTS <= names,
          f"missing {REQUIRED_PARTS - names}")

    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    sheets = workbook.findall(".//s:sheet", NS)
    check("declares exactly one sheet", len(sheets) == 1, f"found {len(sheets)}")

    sheet = ET.fromstring(zf.read("xl/worksheets/sheet1.xml"))
    rows = sheet.findall(".//s:sheetData/s:row", NS)
    check("has a header row plus data rows", len(rows) >= 2, f"only {len(rows)} row(s)")

    def cell_values(row):
        values = []
        for c in row.findall("s:c", NS):
            inline = c.find("s:is/s:t", NS)
            v = c.find("s:v", NS)
            values.append(inline.text if inline is not None
                          else (v.text if v is not None else None))
        return values

    headers = cell_values(rows[0])
    check("header row matches the documented schema", headers == EXPECTED_HEADERS,
          f"got {headers}")

    first = cell_values(rows[1])
    check("first data row is populated", any(v for v in first), "all cells empty")
    check("frozen header pane present", sheet.find(".//s:pane", NS) is not None)
    check("autofilter present", sheet.find("s:autoFilter", NS) is not None)

    print(f"\n  header : {', '.join(headers[:6])} …")
    print(f"  row 2  : {', '.join(str(v) for v in first[:6])} …")
    print(f"  rows   : {len(rows) - 1} data row(s)")

print(f"\n{'✗ ' + str(len(failures)) + ' check(s) failed' if failures else '✓ workbook is valid'}")
sys.exit(1 if failures else 0)
