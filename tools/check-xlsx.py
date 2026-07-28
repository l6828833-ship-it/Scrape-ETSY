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

ROOT = Path(__file__).resolve().parent.parent
path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests/out/sample.xlsx"
workbook_path = ROOT / "tests/out/sample-workbook.xlsx"

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


# The deep-scrape export writes one sheet per dataset into a single workbook.
if workbook_path.exists():
    print(f"\nValidating {workbook_path.name} ({workbook_path.stat().st_size} bytes)")
    with zipfile.ZipFile(workbook_path) as zf:
        check("multi-sheet ZIP is intact (all CRCs valid)", zf.testzip() is None, "corrupt entry")

        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        names = [s.get("name") for s in workbook.findall(".//s:sheet", NS)]
        check("declares one sheet per dataset", len(names) == 3, f"found {names}")
        check("sheets are named after their datasets",
              names == ["Search rows", "Listing details", "Reviews"], f"got {names}")

        rel_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        targets = sorted(r.get("Target") for r in rel_root)
        expected = sorted(f"worksheets/sheet{i}.xml" for i in (1, 2, 3))
        check("every sheet is wired to a relationship", targets == expected, f"got {targets}")
        check("all worksheet parts are present",
              all(f"xl/worksheets/sheet{i}.xml" in zf.namelist() for i in (1, 2, 3)))

        detail_sheet = ET.fromstring(zf.read("xl/worksheets/sheet2.xml"))
        detail_rows = detail_sheet.findall(".//s:sheetData/s:row", NS)
        check("listing-details sheet has data", len(detail_rows) >= 2, f"{len(detail_rows)} row(s)")

        def cells(row):
            out = []
            for c in row.findall("s:c", NS):
                inline = c.find("s:is/s:t", NS)
                v = c.find("s:v", NS)
                out.append(inline.text if inline is not None
                           else (v.text if v is not None else None))
            return out

        headers = cells(detail_rows[0])
        values = cells(detail_rows[1])
        row_map = dict(zip(headers, values))
        check("nested lists are flattened into cells",
              row_map.get("materials") == "Recycled paper; Archival ink",
              f"materials={row_map.get('materials')!r}")
        check("variation groups are human readable",
              row_map.get("variations") == "Size: A4 | A3; Color: Sage",
              f"variations={row_map.get('variations')!r}")
        check("velocity columns survive the round-trip",
              row_map.get("favoritesPerDay") == "15" and row_map.get("opportunityScore") == "71",
              f"favoritesPerDay={row_map.get('favoritesPerDay')!r}")
        print(f"\n  sheets : {', '.join(names)}")

print(f"\n{'✗ ' + str(len(failures)) + ' check(s) failed' if failures else '✓ workbook(s) are valid'}")
sys.exit(1 if failures else 0)
