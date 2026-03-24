import Papa from 'papaparse';
import type { ImportedDataset, ProcedureConflict, ProcedureRecord } from '../types';

const REQUIRED_COLUMNS = ['codigoprocedimento', 'nomeprocedimento', 'nomedentista'];

const normalizeHeader = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();

const normalizeCell = (value: unknown) => String(value ?? '').trim();

const mapRow = (row: Record<string, unknown>, index: number): ProcedureRecord | null => {
  const normalizedMap = new Map<string, unknown>();

  Object.entries(row).forEach(([key, value]) => {
    normalizedMap.set(normalizeHeader(key), value);
  });

  const codigoProcedimento = normalizeCell(normalizedMap.get('codigoprocedimento'));
  const nomeProcedimento = normalizeCell(normalizedMap.get('nomeprocedimento'));
  const nomeDentista = normalizeCell(normalizedMap.get('nomedentista'));

  if (!codigoProcedimento && !nomeProcedimento && !nomeDentista) {
    return null;
  }

  if (!codigoProcedimento || !nomeProcedimento || !nomeDentista) {
    throw new Error(
      `Linha ${index + 2} inválida. As colunas codigoProcedimento, nomeProcedimento e nomeDentista precisam estar preenchidas.`,
    );
  }

  return {
    id: `${codigoProcedimento}-${nomeDentista}-${index}`,
    codigoProcedimento,
    nomeProcedimento,
    nomeDentista,
  };
};

const validateHeaders = (headers: string[]) => {
  const normalized = headers.map(normalizeHeader);
  const missing = REQUIRED_COLUMNS.filter((column) => !normalized.includes(column));

  if (missing.length > 0) {
    throw new Error(
      `Arquivo sem colunas obrigatórias: ${missing.join(', ')}. Esperado: codigoProcedimento, nomeProcedimento, nomeDentista.`,
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
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error('Nenhuma aba encontrada no arquivo.');
  }

  const worksheet = workbook.Sheets[firstSheetName];

  return XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
  });
};

export const parseUploadedFile = async (file: File): Promise<ImportedDataset> => {
  const isCsv = file.name.toLowerCase().endsWith('.csv');
  const rows = isCsv ? await parseCsv(file) : await parseSpreadsheet(file);

  if (rows.length === 0) {
    throw new Error('O arquivo não possui linhas para importar.');
  }

  validateHeaders(Object.keys(rows[0]));

  const records = rows
    .map((row, index) => mapRow(row, index))
    .filter((row): row is ProcedureRecord => row !== null);

  if (records.length === 0) {
    throw new Error('Nenhum registro válido foi encontrado no arquivo.');
  }

  return {
    fileName: file.name,
    importedAt: new Date().toISOString(),
    records,
    conflicts: collectConflicts(records),
  };
};
