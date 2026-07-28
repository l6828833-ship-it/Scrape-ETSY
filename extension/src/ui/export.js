/**
 * Serialisation + download helpers. These run in the UI page (not the worker)
 * because Blob/URL.createObjectURL are unavailable in MV3 service workers.
 */

import { FIELDS } from '../common/constants.js';
import { rowsToXlsx } from './xlsx.js';

/** Internal bookkeeping fields are hidden from exports unless asked for. */
const INTERNAL = ['_source', '_sourceUrl'];

export function pickFields(rows, { includeDebug = false } = {}) {
  const fields = includeDebug ? [...FIELDS, ...INTERNAL] : [...FIELDS];
  return {
    fields,
    rows: rows.map((row) => {
      const out = {};
      for (const f of fields) out[f] = row[f] === undefined ? null : row[f];
      return out;
    }),
  };
}

export function toJson(rows, { pretty = true, includeDebug = false } = {}) {
  const { rows: shaped } = pickFields(rows, { includeDebug });
  return new Blob([JSON.stringify(shaped, null, pretty ? 2 : 0)], {
    type: 'application/json;charset=utf-8',
  });
}

/** Newline-delimited JSON — friendlier for large datasets / data pipelines. */
export function toJsonl(rows, { includeDebug = false } = {}) {
  const { rows: shaped } = pickFields(rows, { includeDebug });
  return new Blob([shaped.map((r) => JSON.stringify(r)).join('\n') + '\n'], {
    type: 'application/x-ndjson;charset=utf-8',
  });
}

function csvCell(value, delimiter) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'boolean') s = value ? 'true' : 'false';
  const mustQuote = s.includes(delimiter) || s.includes('"') || /[\r\n]/.test(s)
    // Guard against spreadsheet formula injection.
    || /^[=+\-@\t]/.test(s);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return mustQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, { delimiter = ',', bom = true, includeDebug = false } = {}) {
  const { fields, rows: shaped } = pickFields(rows, { includeDebug });
  const lines = [fields.join(delimiter)];
  for (const row of shaped) {
    lines.push(fields.map((f) => csvCell(row[f], delimiter)).join(delimiter));
  }
  // Excel needs the BOM to detect UTF-8; CRLF per RFC 4180.
  const body = (bom ? '\ufeff' : '') + lines.join('\r\n') + '\r\n';
  return new Blob([body], { type: 'text/csv;charset=utf-8' });
}

export function toXlsx(rows, { includeDebug = false } = {}) {
  const { fields, rows: shaped } = pickFields(rows, { includeDebug });
  return rowsToXlsx(shaped, fields);
}

export function timestampedName(extension, prefix = 'etsy-search') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}-${stamp}.${extension}`;
}

/**
 * Save a Blob via chrome.downloads, falling back to an anchor click when the
 * downloads permission is unavailable.
 * @returns {Promise<string>} the filename used
 */
export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    if (chrome.downloads && chrome.downloads.download) {
      await chrome.downloads.download({ url, filename, saveAs: false });
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    return filename;
  } finally {
    // Give Chrome a moment to start reading the blob before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

export const FORMATS = {
  json: { label: 'JSON', ext: 'json', build: toJson },
  jsonl: { label: 'JSONL', ext: 'jsonl', build: toJsonl },
  csv: { label: 'CSV', ext: 'csv', build: toCsv },
  xlsx: { label: 'Excel', ext: 'xlsx', build: toXlsx },
};

export async function exportRows(rows, format, options = {}) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown export format: ${format}`);
  if (!rows.length) throw new Error('Nothing to export yet');
  const blob = spec.build(rows, options);
  return downloadBlob(blob, timestampedName(spec.ext));
}
