import Papa from 'papaparse';
import type { ImportedDataset, ProcedureConflict, ProcedureRecord } from '../types';

const REQUIRED_COLUMNS = ['codigoprocedimento', 'nomeprocedimento', 'nomedentista', 'datarealizacao'];
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

const normalizeHeader = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();

const normalizeCell = (value: unknown) => String(value ?? '').trim();

const buildIsoDate = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    year < 1900 ||
    year > 2100
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const parseExcelSerialDate = (serial: number): string | null => {
  if (!Number.isFinite(serial)) {
    return null;
  }

  const wholeDays = Math.trunc(serial);

  if (wholeDays <= 0) {
    return null;
  }

  const date = new Date(EXCEL_EPOCH_UTC + wholeDays * DAY_IN_MS);
  return buildIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};

const parseDateText = (value: string): string | null => {
  const text = value.trim();

  if (!text) {
    return null;
  }

  const isoLikeMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);

  if (isoLikeMatch) {
    const [, year, month, day] = isoLikeMatch;
    return buildIsoDate(Number(year), Number(month), Number(day));
  }

  const brLikeMatch = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);

  if (brLikeMatch) {
    const [, day, month, yearRaw] = brLikeMatch;
    const year = yearRaw.length === 2 ? Number(`20${yearRaw}`) : Number(yearRaw);
    return buildIsoDate(year, Number(month), Number(day));
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return buildIsoDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
};

const normalizeRealizationDate = (value: unknown): string | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return buildIsoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === 'number') {
    return parseExcelSerialDate(value);
  }

  const text = normalizeCell(value);

  if (!text) {
    return null;
  }

  if (/^\d+(?:[.,]\d+)?$/.test(text)) {
    const numericValue = Number.parseFloat(text.replace(',', '.'));
    const serialDate = parseExcelSerialDate(numericValue);

    if (serialDate) {
      return serialDate;
    }
  }

  return parseDateText(text);
};

const mapRow = (row: Record<string, unknown>, index: number): ProcedureRecord | null => {
  const normalizedMap = new Map<string, unknown>();

  Object.entries(row).forEach(([key, value]) => {
    normalizedMap.set(normalizeHeader(key), value);
  });

  const codigoProcedimento = normalizeCell(normalizedMap.get('codigoprocedimento'));
  const nomeProcedimento = normalizeCell(normalizedMap.get('nomeprocedimento'));
  const nomeDentista = normalizeCell(normalizedMap.get('nomedentista'));
  const dataRealizacao = normalizeRealizationDate(normalizedMap.get('datarealizacao'));

  if (!codigoProcedimento && !nomeProcedimento && !nomeDentista && !dataRealizacao) {
    return null;
  }

  if (!codigoProcedimento || !nomeProcedimento || !nomeDentista || !dataRealizacao) {
    throw new Error(
      `Linha ${index + 2} invalida. As colunas codigoProcedimento, nomeProcedimento, nomeDentista e dataRealizacao precisam estar preenchidas.`,
    );
  }

  return {
    id: `${codigoProcedimento}-${nomeDentista}-${index}`,
    codigoProcedimento,
    nomeProcedimento,
    nomeDentista,
    dataRealizacao,
  };
};

const validateHeaders = (headers: string[]) => {
  const normalized = headers.map(normalizeHeader);
  const missing = REQUIRED_COLUMNS.filter((column) => !normalized.includes(column));

  if (missing.length > 0) {
    throw new Error(
      `Arquivo sem colunas obrigatorias: ${missing.join(', ')}. Esperado: codigoProcedimento, nomeProcedimento, nomeDentista, dataRealizacao.`,
    );
  }
};

const collectConflicts = (records: ProcedureRecord[]): ProcedureConflict[] => {
  const codeMap = new Map<string, Set<string>>();

  records.forEach((record) => {
    const current = codeMap.get(record.codigoProcedimento) ?? new Set<string>();
    current.add(record.nomeProcedimento);
    codeMap.set(record.codigoProcedimento, current);
  });

  return Array.from(codeMap.entries())
    .filter(([, names]) => names.size > 1)
    .map(([codigoProcedimento, nomes]) => ({
      codigoProcedimento,
      nomesProcedimento: Array.from(nomes),
    }));
};

const decodeCsvBuffer = (buffer: ArrayBuffer) => {
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

  if (!utf8Text.includes('\uFFFD')) {
    return utf8Text;
  }

  return new TextDecoder('windows-1252').decode(buffer);
};

const parseCsv = async (file: File) =>
  new Promise<Record<string, unknown>[]>((resolve, reject) => {
    file
      .arrayBuffer()
      .then((buffer) => {
        const csvText = decodeCsvBuffer(buffer);

        Papa.parse<Record<string, unknown>>(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            if (results.errors.length > 0) {
              reject(new Error(results.errors[0].message));
              return;
            }

            resolve(results.data);
          },
          error: (error: Error) => reject(error),
        });
      })
      .catch((error: unknown) => reject(error));
  });

const parseSpreadsheet = async (file: File) => {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error('Nenhuma aba encontrada no arquivo.');
  }

  const worksheet = workbook.Sheets[firstSheetName];

  return XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
  });
};

const detectCompetencyMonth = (records: ProcedureRecord[]): string => {
  const months = Array.from(new Set(records.map((record) => record.dataRealizacao.slice(0, 7))));

  if (months.length === 0) {
    throw new Error('Nao foi possivel identificar o mes pela coluna dataRealizacao.');
  }

  if (months.length > 1) {
    throw new Error(
      `Arquivo contem mais de um mes em dataRealizacao (${months.join(', ')}). Envie um arquivo por mes.`,
    );
  }

  return months[0];
};

export const parseUploadedFile = async (file: File): Promise<ImportedDataset> => {
  const isCsv = file.name.toLowerCase().endsWith('.csv');
  const rows = isCsv ? await parseCsv(file) : await parseSpreadsheet(file);

  if (rows.length === 0) {
    throw new Error('O arquivo nao possui linhas para importar.');
  }

  validateHeaders(Object.keys(rows[0]));

  const records = rows
    .map((row, index) => mapRow(row, index))
    .filter((row): row is ProcedureRecord => row !== null);

  if (records.length === 0) {
    throw new Error('Nenhum registro valido foi encontrado no arquivo.');
  }

  return {
    fileName: file.name,
    importedAt: new Date().toISOString(),
    competencyMonth: detectCompetencyMonth(records),
    records,
    conflicts: collectConflicts(records),
  };
};
