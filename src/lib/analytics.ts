import type {
  CodeSummary,
  DentistBreakdown,
  GroupAnalytics,
  GroupCodeMetrics,
  ProcedureGroup,
  ProcedureRecord,
} from '../types';

export const summarizeCodes = (records: ProcedureRecord[]): CodeSummary[] => {
  const codeMap = new Map<string, CodeSummary>();

  records.forEach((record) => {
    const current = codeMap.get(record.codigoProcedimento);

    if (current) {
      current.total += 1;
      return;
    }

    codeMap.set(record.codigoProcedimento, {
      codigoProcedimento: record.codigoProcedimento,
      nomeProcedimento: record.nomeProcedimento,
      total: 1,
    });
  });

  return Array.from(codeMap.values()).sort((a, b) => b.total - a.total);
};

export const analyzeGroup = (group: ProcedureGroup, records: ProcedureRecord[]): GroupAnalytics => {
  const selectedCodes = new Set(group.codes);
  const filtered = records.filter((record) => selectedCodes.has(record.codigoProcedimento));
  const groupTotal = filtered.length;
  const codeTotals = new Map<string, number>();
  const procedureNames = new Map<string, string>();
  const dentistMap = new Map<string, Map<string, number>>();

  filtered.forEach((record) => {
    codeTotals.set(record.codigoProcedimento, (codeTotals.get(record.codigoProcedimento) ?? 0) + 1);
    procedureNames.set(record.codigoProcedimento, record.nomeProcedimento);

    const dentistCodes = dentistMap.get(record.nomeDentista) ?? new Map<string, number>();
    dentistCodes.set(record.codigoProcedimento, (dentistCodes.get(record.codigoProcedimento) ?? 0) + 1);
    dentistMap.set(record.nomeDentista, dentistCodes);
  });

  const codes: GroupCodeMetrics[] = group.codes.map((code) => {
    const total = codeTotals.get(code) ?? 0;

    return {
      codigoProcedimento: code,
      nomeProcedimento: procedureNames.get(code) ?? 'Codigo sem ocorrencia no arquivo',
      total,
      actualPercentage: groupTotal > 0 ? (total / groupTotal) * 100 : 0,
    };
  });

  const dentists: DentistBreakdown[] = Array.from(dentistMap.entries())
    .map(([nomeDentista, codesMap]) => {
      const dentistCodes = Array.from(codesMap.entries())
        .map(([codigoProcedimento, total]) => ({
          codigoProcedimento,
          nomeProcedimento: procedureNames.get(codigoProcedimento) ?? codigoProcedimento,
          total,
        }))
        .sort((a, b) => b.total - a.total);

      return {
        nomeDentista,
        total: dentistCodes.reduce((sum, code) => sum + code.total, 0),
        codes: dentistCodes,
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    groupTotal,
    codes: codes.sort((a, b) => b.total - a.total),
    dentists,
  };
};
