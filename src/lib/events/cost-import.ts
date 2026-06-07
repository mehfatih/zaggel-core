// Ad-spend CSV import (S5, scope §3 — manual CSV v1). PURE parser. Expected header
// (case-insensitive, order-independent): spend_on, amount, currency, and optional
// utm_campaign, utm_content, utm_term. Returns parsed rows + per-line errors so the
// dashboard can show exactly which lines were rejected (no silent drops).

export interface ParsedCost {
  spendOn: string; // YYYY-MM-DD
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  amount: number;
  currency: string;
}

export interface CostParseResult {
  rows: ParsedCost[];
  errors: { line: number; message: string }[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function splitCsvLine(line: string): string[] {
  // Minimal CSV: comma-separated, optional double-quoted fields (no embedded newlines).
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse a cost CSV. Header row required; blank lines skipped. */
export function parseCostCsv(csv: string): CostParseResult {
  const result: CostParseResult = { rows: [], errors: [] };
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    result.errors.push({ line: 0, message: 'empty_file' });
    return result;
  }

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const iDate = col('spend_on');
  const iAmount = col('amount');
  const iCurrency = col('currency');
  const iCampaign = col('utm_campaign');
  const iContent = col('utm_content');
  const iTerm = col('utm_term');

  if (iDate < 0 || iAmount < 0 || iCurrency < 0) {
    result.errors.push({ line: 1, message: 'missing_required_columns (need spend_on, amount, currency)' });
    return result;
  }

  for (let n = 1; n < lines.length; n++) {
    const cells = splitCsvLine(lines[n]!);
    const at = (i: number): string => (i >= 0 ? cells[i] ?? '' : '');
    const spendOn = at(iDate);
    const amount = Number(at(iAmount));
    const currency = at(iCurrency).toUpperCase();
    const lineNo = n + 1;

    if (!DATE_RE.test(spendOn)) { result.errors.push({ line: lineNo, message: 'invalid spend_on (YYYY-MM-DD)' }); continue; }
    if (!Number.isFinite(amount) || amount < 0) { result.errors.push({ line: lineNo, message: 'invalid amount' }); continue; }
    if (currency.length < 3 || currency.length > 4) { result.errors.push({ line: lineNo, message: 'invalid currency' }); continue; }

    result.rows.push({
      spendOn,
      utmCampaign: at(iCampaign) || null,
      utmContent: at(iContent) || null,
      utmTerm: at(iTerm) || null,
      amount,
      currency,
    });
  }
  return result;
}
