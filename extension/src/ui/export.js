/**
 * Serialisation + download helpers. These run in the UI page (not the worker)
 * because Blob/URL.createObjectURL are unavailable in MV3 service workers.
 *
 * Three datasets can be exported: the search rows, the listing-detail records,
 * and the reviews. JSON keeps nested values (variations, tags, photos) as real
 * arrays/objects; CSV and Excel flatten them, because a spreadsheet cell cannot
 * hold a list.
 */

import {
  FIELDS, DETAIL_FIELDS, REVIEW_FIELDS, SNAPSHOT_FIELDS, LOG_FIELDS, DATASETS,
} from '../common/constants.js';
import { rowsToXlsx, rowsToWorkbook } from './xlsx.js';

/** Internal bookkeeping fields are hidden from exports unless asked for. */
const INTERNAL = ['_source', '_sourceUrl', 'detailSource'];

export const DATASET_FIELDS = {
  [DATASETS.search]: FIELDS,
  [DATASETS.details]: DETAIL_FIELDS,
  [DATASETS.reviews]: REVIEW_FIELDS,
  [DATASETS.history]: SNAPSHOT_FIELDS,
  [DATASETS.log]: LOG_FIELDS,
};

export const DATASET_LABELS = {
  [DATASETS.search]: 'Search rows',
  [DATASETS.details]: 'Listing details',
  [DATASETS.reviews]: 'Reviews',
  [DATASETS.history]: 'Snapshot history',
  [DATASETS.log]: 'Run log',
  [DATASETS.all]: 'All datasets',
};

/**
 * Every table "All datasets" covers, in the order they belong in a workbook:
 * the listings, their children, then the record of how they were obtained.
 */
export const ALL_DATASETS = [
  DATASETS.search, DATASETS.details, DATASETS.reviews, DATASETS.history, DATASETS.log,
];

/** Arrays/objects become spreadsheet-friendly scalars. */
function flattenValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value
      .map((item) => {
        if (item === null || item === undefined) return '';
        if (typeof item === 'object') {
          // {name, options[]} variation groups read best as "Size: S | M | L".
          if (item.name && Array.isArray(item.options)) return `${item.name}: ${item.options.join(' | ')}`;
          return JSON.stringify(item);
        }
        return String(item);
      })
      .filter(Boolean)
      .join('; ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * @param {Array<object>} rows
 * @param {{fields?:string[], includeDebug?:boolean, flatten?:boolean}} [options]
 */
export function pickFields(rows, options = {}) {
  const { fields: requested, includeDebug = false, flatten = false } = options;
  const base = requested || FIELDS;
  const extras = includeDebug ? INTERNAL.filter((f) => !base.includes(f)) : [];
  const fields = [...base, ...extras];
  return {
    fields,
    rows: (rows || []).map((row) => {
      const out = {};
      for (const f of fields) {
        const value = row[f] === undefined ? null : row[f];
        out[f] = flatten ? flattenValue(value) : value;
      }
      return out;
    }),
  };
}

export function toJson(rows, options = {}) {
  const { rows: shaped } = pickFields(rows, options);
  return new Blob([JSON.stringify(shaped, null, options.pretty === false ? 0 : 2)], {
    type: 'application/json;charset=utf-8',
  });
}

/** Newline-delimited JSON — friendlier for large datasets / data pipelines. */
export function toJsonl(rows, options = {}) {
  const { rows: shaped } = pickFields(rows, options);
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

export function toCsv(rows, options = {}) {
  const { delimiter = ',', bom = true } = options;
  const { fields, rows: shaped } = pickFields(rows, { ...options, flatten: true });
  const lines = [fields.join(delimiter)];
  for (const row of shaped) {
    lines.push(fields.map((f) => csvCell(row[f], delimiter)).join(delimiter));
  }
  // Excel needs the BOM to detect UTF-8; CRLF per RFC 4180.
  const body = (bom ? '\ufeff' : '') + lines.join('\r\n') + '\r\n';
  return new Blob([body], { type: 'text/csv;charset=utf-8' });
}

export function toXlsx(rows, options = {}) {
  const { fields, rows: shaped } = pickFields(rows, { ...options, flatten: true });
  return rowsToXlsx(shaped, fields, options.sheetName || 'Etsy listings');
}

/**
 * One workbook, one sheet per non-empty dataset — the format that actually
 * suits this data, since reviews are a one-to-many child of listings.
 * @param {{search?:Array, details?:Array, reviews?:Array}} data
 */
export function toWorkbook(data, options = {}) {
  const sheets = [];
  for (const dataset of ALL_DATASETS) {
    const rows = data[dataset];
    if (!rows || !rows.length) continue;
    const shaped = pickFields(rows, {
      ...options,
      fields: DATASET_FIELDS[dataset],
      flatten: true,
    });
    sheets.push({ name: DATASET_LABELS[dataset], fields: shaped.fields, rows: shaped.rows });
  }
  if (!sheets.length) throw new Error('Nothing to export yet');
  return rowsToWorkbook(sheets);
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

const FILE_PREFIX = {
  [DATASETS.search]: 'etsy-search',
  [DATASETS.details]: 'etsy-listings',
  [DATASETS.reviews]: 'etsy-reviews',
  [DATASETS.history]: 'etsy-history',
  [DATASETS.log]: 'etsy-run-log',
  [DATASETS.all]: 'etsy-dataset',
};

export async function exportRows(rows, format, options = {}) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown export format: ${format}`);
  if (!rows.length) throw new Error('Nothing to export yet');
  const blob = spec.build(rows, options);
  const prefix = FILE_PREFIX[options.dataset] || 'etsy-search';
  return downloadBlob(blob, timestampedName(spec.ext, prefix));
}

/**
 * Export one dataset, or everything at once.
 * @param {string} dataset one of DATASETS
 * @param {string} format json | jsonl | csv | xlsx
 * @param {{search:Array, details:Array, reviews:Array}} data
 */
export async function exportDataset(dataset, format, data, options = {}) {
  if (dataset !== DATASETS.all) {
    const rows = data[dataset] || [];
    return exportRows(rows, format, {
      ...options,
      dataset,
      fields: DATASET_FIELDS[dataset],
      sheetName: DATASET_LABELS[dataset],
    });
  }

  // "All datasets" only makes sense in formats that can hold several tables.
  if (format === 'xlsx') {
    return downloadBlob(toWorkbook(data, options), timestampedName('xlsx', FILE_PREFIX[DATASETS.all]));
  }
  if (format === 'json') {
    const payload = { exportedAt: new Date().toISOString() };
    // The run's own account of itself, when the caller supplied it. Not a table,
    // so it has no sheet in the workbook, but JSON can carry it.
    if (data.run) payload.run = data.run;
    for (const dataset of ALL_DATASETS) {
      payload[dataset] = pickFields(data[dataset] || [], {
        ...options,
        fields: DATASET_FIELDS[dataset],
      }).rows;
    }
    if (ALL_DATASETS.every((d) => !payload[d].length)) {
      throw new Error('Nothing to export yet');
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    return downloadBlob(blob, timestampedName('json', FILE_PREFIX[DATASETS.all]));
  }
  throw new Error('CSV and JSONL hold one table — pick a single dataset, or use Excel/JSON');
}
