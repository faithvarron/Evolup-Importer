const XLSX = require('xlsx-js-style');

const STYLES = {
  red: {
    fill: { patternType: 'solid', fgColor: { rgb: 'FF0000' } },
    font: { color: { rgb: 'FFFFFF' }, bold: true },
  },
  lightBlue: {
    fill: { patternType: 'solid', fgColor: { rgb: 'ADD8E6' } },
    font: { color: { rgb: '000000' }, bold: false },
  },
  green: {
    fill: { patternType: 'solid', fgColor: { rgb: '90EE90' } },
    font: { color: { rgb: '006400' }, bold: false },
  },
};

function formatAmazonUrl(raw) {
  if (!raw) return raw;
  const url = raw.toString().trim();
  const m = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (m) return `https://www.amazon.de/dp/${m[1].toUpperCase()}`;
  if (/^[A-Z0-9]{10}$/i.test(url)) return `https://www.amazon.de/dp/${url.toUpperCase()}`;
  return url;
}

function getHeaders(sheet, range) {
  const headers = {};
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: col })];
    if (cell && cell.v) headers[cell.v.toString().trim()] = col;
  }
  return headers;
}

function readUrls(filePath, {
  kategorieColName = 'Kategorie',
  neuerProduktnameColName = 'Neuer Produktname',
  amazonUrlColName = 'Amazon.de URL',
} = {}, log = () => {}) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(sheet['!ref']);

  const headers = getHeaders(sheet, range);
  log(`Excel headers found: ${Object.keys(headers).map(k => `"${k}"`).join(', ')}`);

  const kategorieCol   = headers[kategorieColName];
  const produktnameCol = headers[neuerProduktnameColName];
  const urlColIdx      = headers[amazonUrlColName];

  log(`Column mapping — Amazon URL: "${amazonUrlColName}" → col ${urlColIdx ?? 'NOT FOUND'} | Kategorie: "${kategorieColName}" → col ${kategorieCol ?? 'NOT FOUND'} | Neuer Produktname: "${neuerProduktnameColName}" → col ${produktnameCol ?? 'NOT FOUND'}`);

  if (urlColIdx === undefined) {
    log(`ERROR: Column "${amazonUrlColName}" not found in Excel headers. Check the "Amazon URL column" input matches exactly.`);
    return [];
  }

  const urls = [];
  for (let row = 1; row <= range.e.r; row++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: urlColIdx })];
    if (cell && cell.v) {
      const url = formatAmazonUrl(cell.v.toString().trim());

      const getCellValue = (colIdx) => {
        if (colIdx === undefined) return null;
        const c = sheet[XLSX.utils.encode_cell({ r: row, c: colIdx })];
        return c ? c.v?.toString().trim() : null;
      };

      urls.push({
        row: row + 1,
        url,
        kategorie: getCellValue(kategorieCol),
        neuerProduktname: getCellValue(produktnameCol),
      });
    }
  }
  return urls;
}

/**
 * Writes ALL row statuses in one operation so styles never overwrite each other.
 * Each call reads the original data, applies every accumulated row color, and saves.
 */
function writeAllStatuses(filePath, { successRows = [], alreadyImportedRows = [], failedRows = [] }) {
  try {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.c < 10) range.e.c = 10;
    sheet['!ref'] = XLSX.utils.encode_range(range);

    const applyRows = (rows, style, defaultText) => {
      for (const { row, error } of rows) {
        for (let col = range.s.c; col <= range.e.c; col++) {
          const addr = XLSX.utils.encode_cell({ r: row - 1, c: col });
          if (!sheet[addr]) sheet[addr] = { v: '', t: 's' };
          sheet[addr].s = style;
        }
        sheet[`K${row}`] = { v: error || defaultText, t: 's', s: style };
      }
    };

    applyRows(successRows,       STYLES.green,     'Imported successfully');
    applyRows(alreadyImportedRows, STYLES.lightBlue, 'Already imported');
    applyRows(failedRows,        STYLES.red,       'Import failed');

    if (!sheet['K1']) {
      sheet['K1'] = { v: 'Import Status', t: 's', s: { font: { bold: true } } };
    }

    XLSX.writeFile(wb, filePath, { bookType: 'xlsx', type: 'file' });
  } catch (e) {
    console.error(`  Failed to write statuses: ${e.message}`);
  }
}

module.exports = { readUrls, writeAllStatuses };
