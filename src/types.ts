export type ProcedureRecord = {
  id: string;
  codigoProcedimento: string;
  nomeProcedimento: string;
  nomeDentista: string;
};

export type ImportedDataset = {
  fileName: string;
  importedAt: string;
  records: ProcedureRecord[];
  conflicts: ProcedureConflict[];
};

export type ProcedureConflict = {
  codigoProcedimento: string;
  nomesProcedimento: string[];
};

export type ProcedureGroup = {
  id: string;
  name: string;
  codes: string[];
  cutoffPercentage: number;
  createdAt: string;
  updatedAt: string;
};

export type CodeSummary = {
  codigoProcedimento: string;
  nomeProcedimento: string;
  total: number;
};

export type GroupCodeMetrics = {
  codigoProcedimento: string;
  nomeProcedimento: string;
  total: number;
  actualPercentage: number;
};

export type DentistBreakdown = {
  nomeDentista: string;
  total: number;
  codes: {
    codigoProcedimento: string;
    nomeProcedimento: string;
    total: number;
  }[];
};

export type GroupAnalytics = {
  groupTotal: number;
  codes: GroupCodeMetrics[];
  dentists: DentistBreakdown[];
};
