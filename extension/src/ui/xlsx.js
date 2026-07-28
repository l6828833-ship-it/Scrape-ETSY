/**
 * Minimal .xlsx (SpreadsheetML + ZIP) writer — zero dependencies.
 *
 * MV3 blocks remote scripts, so bundling SheetJS-style libraries is off the
 * table for a small extension. We only need one sheet with a header row, so we
 * emit the four mandatory OPC parts and store them uncompressed (method 0),
 * which keeps the ZIP writer to a CRC-32 table and a couple of headers.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/**
 * @param {Array<{name:string, data:Uint8Array}>} entries
 * @returns {Blob} application/zip
 */
function makeZip(entries) {
  const { time, day } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method: store
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra length

    chunks.push(new Uint8Array(local.buffer), nameBytes, entry.data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true); // version made by
    dir.setUint16(6, 20, true); // version needed
    dir.setUint16(8, 0, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, day, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint16(30, 0, true);
    dir.setUint16(32, 0, true);
    dir.setUint16(34, 0, true);
    dir.setUint16(36, 0, true);
    dir.setUint32(38, 0, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control chars Excel refuses to open.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - rem) / 26);
  }
  return name;
}

function cellXml(ref, value) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(headers, rows) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  parts.push('<sheetViews><sheetView workbookViewId="0" tabSelected="1">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  parts.push('<cols>' + headers.map((h, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${Math.min(48, Math.max(10, h.length + 6))}" customWidth="1"/>`).join('') + '</cols>');
  parts.push('<sheetData>');
  parts.push('<row r="1">' + headers.map((h, i) => cellXml(`${colName(i)}1`, String(h))).join('') + '</row>');
  rows.forEach((row, r) => {
    const rowNum = r + 2;
    const cells = headers.map((h, i) => cellXml(`${colName(i)}${rowNum}`, row[h] === undefined ? null : row[h]));
    parts.push(`<row r="${rowNum}">${cells.join('')}</row>`);
  });
  parts.push('</sheetData>');
  const lastCol = colName(Math.max(0, headers.length - 1));
  parts.push(`<autoFilter ref="A1:${lastCol}${rows.length + 1}"/>`);
  parts.push('</worksheet>');
  return parts.join('');
}

function safeSheetName(name, index) {
  const cleaned = String(name || `Sheet${index + 1}`)
    .replace(/[[\]:*?/\\]/g, ' ')
    .slice(0, 31)
    .trim();
  return escapeXml(cleaned || `Sheet${index + 1}`);
}

/**
 * Build a workbook with one worksheet per entry.
 * @param {Array<{name:string, fields:string[], rows:Array<object>}>} sheets
 * @returns {Blob} xlsx workbook
 */
export function rowsToWorkbook(sheets) {
  const list = (sheets || []).filter(Boolean);
  if (!list.length) throw new Error('rowsToWorkbook: at least one sheet is required');

  const overrides = list
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml"`
      + ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    .join('');
  const sheetTags = list
    .map((sheet, i) => `<sheet name="${safeSheetName(sheet.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const rels = list
    .map((_, i) => `<Relationship Id="rId${i + 1}"`
      + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
      + ` Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');

  const files = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + overrides
        + '</Types>'),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>'),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets>${sheetTags}</sheets>`
        + '</workbook>'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + rels
        + '</Relationships>'),
    },
    ...list.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encoder.encode(sheetXml(sheet.fields, sheet.rows)),
    })),
  ];
  return makeZip(files);
}

/**
 * Single-sheet convenience wrapper.
 * @param {Array<object>} rows
 * @param {string[]} fields column order (object keys)
 * @param {string} [sheetName]
 * @returns {Blob} xlsx workbook
 */
export function rowsToXlsx(rows, fields, sheetName = 'Etsy listings') {
  return rowsToWorkbook([{ name: sheetName, fields, rows }]);
}

export const __testing = { crc32, makeZip, sheetXml, colName, escapeXml, safeSheetName };
